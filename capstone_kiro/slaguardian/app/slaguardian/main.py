import json
import uuid
from typing import Any
from collections import OrderedDict
from strands import Agent, tool
import asyncio
from strands.agent.conversation_manager.null_conversation_manager import NullConversationManager
from bedrock_agentcore.runtime import BedrockAgentCoreApp
from model.load import load_model

from tools import config, get_sla_status, rollback_alias, write_incident_report

app = BedrockAgentCoreApp()
log = app.logger

# Surface the known-good version(s) from config.json so the model passes
# a real version number to rollback_alias. Data-driven (not hardcoded):
# the tool still validates target_version against known_good_versions as
# the defense-in-depth backstop.
_KNOWN_GOOD = ", ".join(str(v) for v in config.get("known_good_versions", []))

SYSTEM_PROMPT = (
    "You are an SLA remediation operator for a single service. Always "
    "measure first by calling get_sla_status. Remediate only on a real "
    "breach (breached == true): roll back AT MOST ONCE to a known-good "
    "version via rollback_alias, giving a short reason. If the SLA is "
    "NOT breached, do NOT call rollback_alias — instead write an "
    "incident report with action_taken='none'. In every case, finish by "
    "writing exactly one incident report via write_incident_report. Act "
    "only through your tools; never fabricate numbers. "
    f"The known-good version(s) for this service are: {_KNOWN_GOOD}. When "
    "you roll back, pass the exact version number as target_version."
)


# The three SLA Guardian tools: detect, remediate, record.
tools = [get_sla_status, rollback_alias, write_incident_report]

_INLINE_FUNCTION_NAMES = set()


def _make_conversation_manager():
    return NullConversationManager()

# Reuses one Agent per session_id so each session keeps its own in-process
# conversation history (best-effort; resets on cold start). The cache is bounded
# to 128 sessions with LRU eviction (least-recently-used is dropped and its
# history reset) so a single process serving many sessions cannot leak history
# between them or grow without limit. For durable history, attach a session manager.
def agent_factory():
    cache = OrderedDict()
    def get_or_create_agent(session_id):
        if session_id in cache:
            cache.move_to_end(session_id)
            return cache[session_id]
        if len(cache) >= 128:
            cache.popitem(last=False)
        cache[session_id] = Agent(
            model=load_model(),
            system_prompt=SYSTEM_PROMPT,
            tools=tools,
            conversation_manager=_make_conversation_manager(),
            hooks=[
            ],
        )
        return cache[session_id]
    return get_or_create_agent
get_or_create_agent = agent_factory()


def strip_trailing_tool_use(messages: Any) -> list[dict]:
    """Strip toolUse blocks from the tail until the last message has none."""
    if not isinstance(messages, list):
        raise ValueError("messages must be a list")

    messages = list(messages)
    while messages:
        last = messages[-1]
        if not isinstance(last, dict):
            raise ValueError("each message must be an object")
        original_content = last.get("content", [])
        if not isinstance(original_content, list) or not all(isinstance(block, dict) for block in original_content):
            raise ValueError("each message content value must be a list of content blocks")

        content = [block for block in original_content if "toolUse" not in block]
        if len(content) == len(original_content):
            break
        if content:
            messages[-1] = {**last, "content": content}
            break
        messages.pop()

    return messages


def _extract_prompt(payload: dict):
    """Accept validated harness messages, tool results, or a plain prompt string."""
    if not isinstance(payload, dict):
        raise ValueError("payload must be a JSON object")
    if "messages" in payload:
        return strip_trailing_tool_use(payload["messages"])
    if "tool_results" in payload:
        tool_results = payload["tool_results"]
        if not isinstance(tool_results, list) or not all(
            isinstance(tool_result, dict) and isinstance(tool_result.get("toolUseId"), str)
            for tool_result in tool_results
        ):
            raise ValueError("tool_results must contain objects with a toolUseId string")
        return [{"role": "user", "content": [{"toolResult": {
            "toolUseId": tr["toolUseId"],
            "status": tr.get("status", "success"),
            "content": tr.get("content", []),
        }} for tr in tool_results]}]
    # SLA Guardian payload shape: {"service": "..."}. Build the operator
    # prompt deterministically so the system prompt drives the run.
    if "service" in payload:
        service = payload.get("service") or config["service"]
        return (
            f"Evaluate the SLA for service '{service}'. Measure the current "
            "error rate, remediate if it is breached, and write the incident "
            "report."
        )
    prompt = payload.get("prompt", "")
    if not isinstance(prompt, str):
        raise ValueError("prompt must be a string")
    return prompt


def _has_inline_function_call(messages) -> bool:
    """Return True if messages contains an assistant toolUse for an inline function tool."""
    if not _INLINE_FUNCTION_NAMES or not isinstance(messages, list):
        return False
    for msg in messages:
        if msg.get("role") == "assistant":
            for block in msg.get("content", []):
                if isinstance(block, dict) and block.get("toolUse", {}).get("name") in _INLINE_FUNCTION_NAMES:
                    return True
    return False


def _is_inline_function_call(event: dict) -> bool:
    """Check if a contentBlockStart event is for an inline function tool."""
    if not _INLINE_FUNCTION_NAMES:
        return False
    cbs = event.get("contentBlockStart", {})
    start = cbs.get("start", {})
    tool_use = start.get("toolUse") if isinstance(start, dict) else None
    return tool_use is not None and tool_use.get("name") in _INLINE_FUNCTION_NAMES



@app.entrypoint
async def invoke(payload, context):
    log.info("Invoking Agent.....")

    # Per-run observability state. Exactly one structured JSON log line is
    # emitted per run (AgentCore observability parses it from CloudWatch).
    run_id = str(uuid.uuid4())
    error_rate = None
    breached = None
    action_taken = "none"
    tools_called = []
    status = "success"

    session_id = getattr(context, 'session_id', 'default-session')
    agent = get_or_create_agent(session_id)

    prompt = _extract_prompt(payload)

    try:
        async for event in agent.stream_async(
            prompt,
        ):
            if not isinstance(event, dict) or "event" not in event:
                continue

            # Observability: reconstruct which tools ran and the computed
            # outcome from the streamed tool-use/tool-result events.
            inner = event["event"]
            cbs = inner.get("contentBlockStart")
            if cbs is not None:
                start = cbs.get("start") or {}
                use = start.get("toolUse") if isinstance(start, dict) else None
                if use and use.get("name"):
                    tools_called.append(use["name"])
                if not start:
                    continue
            yield event
    except Exception as e:  # noqa: BLE001 — one run must never crash the runtime
        status = "failure"
        log.error("agent run failed: %s", e)

    # Pull the computed error_rate/breached out of the agent's recorded
    # messages (the get_sla_status toolResult), independent of streaming.
    # Strands stores tool results as content blocks of the form
    # {"text": "<json string>"} (or {"json": {...}}); handle both.
    for message in getattr(agent, "messages", []) or []:
        for block in (message.get("content") or []):
            tool_result = block.get("toolResult") if isinstance(block, dict) else None
            if not tool_result:
                continue
            for item in (tool_result.get("content") or []):
                if not isinstance(item, dict):
                    continue
                body = item.get("json")
                if not isinstance(body, dict):
                    text = item.get("text")
                    if isinstance(text, str):
                        try:
                            body = json.loads(text)
                        except (ValueError, TypeError):
                            body = None
                if isinstance(body, dict) and "error_rate" in body:
                    error_rate = body.get("error_rate")
                    breached = body.get("breached")
    if "rollback_alias" in tools_called:
        action_taken = "rollback"

    # Exactly one structured JSON log line per run.
    log.info(json.dumps({
        "run_id": run_id,
        "error_rate": error_rate,
        "breached": breached,
        "action_taken": action_taken,
        "tools_called": tools_called,
        "status": status,
    }))


if __name__ == "__main__":
    app.run()
