import os

from strands.models.bedrock import BedrockModel


def load_model() -> BedrockModel:
    """Get Bedrock model client with the SLA Guardian guardrail attached.

    BOTH guardrail_id and guardrail_version must be set or Strands
    silently drops the guardrail and the agent runs unguarded. Values
    come from the runtime environment (declared under
    environmentVariables in agentcore/agentcore.json).
    """
    return BedrockModel(
        model_id="us.anthropic.claude-sonnet-4-6",
        guardrail_id=os.environ.get("BEDROCK_GUARDRAIL_ID"),
        guardrail_version=os.environ.get("BEDROCK_GUARDRAIL_VERSION", "DRAFT"),
    )
