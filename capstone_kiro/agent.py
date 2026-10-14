"""SLA Guardian agent, packaged for Amazon Bedrock AgentCore.

Detects an SLA breach on a demo service and auto-remediates by rolling
its alias back to a known-good version, writing an incident report as
the verifiable artifact. The runtime contract is
``BedrockAgentCoreApp`` + ``@app.entrypoint`` — identical locally and
deployed. Run locally with ``AGENT_PORT=8081 python agent.py``.
"""
import json
import os
import uuid

from bedrock_agentcore import BedrockAgentCoreApp
from strands import Agent
from strands.models.bedrock import BedrockModel

from tools import config, get_sla_status, rollback_alias, write_incident_report


app = BedrockAgentCoreApp()


# PRIMARY security layer — Bedrock Guardrail wired on the model.
# BOTH guardrail_id and guardrail_version must be set or Strands
# silently drops the guardrail and the agent runs unguarded. Values
# come from the runtime environment; the defaults pin the stage-3
# guardrail (prompt-attack filter).
model = BedrockModel(
    model_id="us.anthropic.claude-sonnet-4-6",
    guardrail_id=os.environ.get("BEDROCK_GUARDRAIL_ID", "fx5ldv3plxha"),
    guardrail_version=os.environ.get("BEDROCK_GUARDRAIL_VERSION", "DRAFT"),
)

SYSTEM_PROMPT = (
    "You are an SLA remediation operator for a single service. Always "
    "measure first by calling get_sla_status. Remediate only on a real "
    "breach (breached == true): roll back AT MOST ONCE to a known-good "
    "version via rollback_alias, giving a short reason. If the SLA is "
    "NOT breached, do NOT call rollback_alias — instead write an "
    "incident report with action_taken='none'. In every case, finish by "
    "writing exactly one incident report via write_incident_report. Act "
    "only through your tools; never fabricate numbers."
)

agent = Agent(
    model=model,
    system_prompt=SYSTEM_PROMPT,
    tools=[get_sla_status, rollback_alias, write_incident_report],
)


@app.entrypoint
def invoke(payload):
    """AgentCore entrypoint — evaluate the SLA for a service and remediate."""
    run_id = str(uuid.uuid4())
    service = payload.get("service", config["service"])
    prompt = (
        f"Evaluate the SLA for service '{service}'. Measure the current "
        "error rate, remediate if it is breached, and write the incident "
        "report."
    )

    error_rate = None
    breached = None
    action_taken = "none"
    tools_called = []
    status = "success"

    try:
        result = agent(prompt)

        # Reconstruct which tools ran and their computed outcome from the
        # agent's tool-call trace (observability — not business logic).
        for message in getattr(result, "messages", []) or []:
            for block in (message.get("content") or []):
                use = block.get("toolUse") if isinstance(block, dict) else None
                if use and use.get("name"):
                    tools_called.append(use["name"])
                tool_result = block.get("toolResult") if isinstance(block, dict) else None
                if tool_result:
                    for item in (tool_result.get("content") or []):
                        payload_text = item.get("json") if isinstance(item, dict) else None
                        if isinstance(payload_text, dict) and "error_rate" in payload_text:
                            error_rate = payload_text.get("error_rate")
                            breached = payload_text.get("breached")
        if "rollback_alias" in tools_called:
            action_taken = "rollback"
    except Exception as e:  # noqa: BLE001 — one run must never crash the runtime
        status = "failure"
        result = {"error": str(e)}

    # Exactly one structured JSON log line per run (CloudWatch picks this
    # up as a parsed metric via AgentCore observability).
    print(json.dumps({
        "run_id": run_id,
        "error_rate": error_rate,
        "breached": breached,
        "action_taken": action_taken,
        "tools_called": tools_called,
        "status": status,
    }))

    message = getattr(result, "message", result)
    return {"run_id": run_id, "result": message}


if __name__ == "__main__":
    # AGENT_PORT: code-server owns 8080 on this instance, so run locally
    # with AGENT_PORT=8081. The deployed AgentCore runtime never runs
    # this block, so the deploy is unaffected.
    app.run(port=int(os.getenv("AGENT_PORT", "8081")))
