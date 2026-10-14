"""Create the SLA Guardian Bedrock Guardrail and publish a version.

Minimal to spec: a single PROMPT_ATTACK content filter (inputStrength
HIGH, outputStrength NONE). This is the primary security layer wired
onto the model in agent.py. setup.sh runs this and captures the
printed id/version to substitute into iam_policy.json and export as
BEDROCK_GUARDRAIL_ID / BEDROCK_GUARDRAIL_VERSION.
"""
import boto3

bedrock = boto3.client("bedrock", region_name="us-east-1")

resp = bedrock.create_guardrail(
    name="sla-guardian-guardrail",
    description="Prompt-attack protection for the SLA Guardian agent.",
    contentPolicyConfig={
        "filtersConfig": [
            {"type": "PROMPT_ATTACK", "inputStrength": "HIGH", "outputStrength": "NONE"},
        ]
    },
    blockedInputMessaging=(
        "I can only help operate the SLA for the configured demo service."
    ),
    blockedOutputsMessaging=(
        "I can't share that. I only report SLA status and remediation."
    ),
)

guardrail_id = resp["guardrailId"]
guardrail_arn = resp["guardrailArn"]

ver = bedrock.create_guardrail_version(
    guardrailIdentifier=guardrail_id,
    description="Initial published version.",
)

print("BEDROCK_GUARDRAIL_ID:", guardrail_id)
print("BEDROCK_GUARDRAIL_ARN:", guardrail_arn)
print("BEDROCK_GUARDRAIL_VERSION:", ver["version"])
