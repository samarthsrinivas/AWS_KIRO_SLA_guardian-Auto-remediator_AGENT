#!/usr/bin/env bash
# setup.sh — provision the SLA Guardian demo service and security
# resources. Creates billable AWS resources; run once before the demo.
# Pair with ./cleanup.sh to tear everything down afterwards.
set -euo pipefail

# boto3 and the AWS CLI resolve no default region on this instance, so
# pin it explicitly for every call made here and by create_guardrail.py.
export AWS_REGION=us-east-1
export AWS_DEFAULT_REGION=us-east-1

ACCOUNT=463332366725
SERVICE=sla-demo-svc
ALIAS=live
ROLE_NAME=sla-guardian-exec-role
BUCKET=sla-guardian-incidents-463332366725-us-east-1
export BUCKET

MODEL_ID=us.anthropic.claude-sonnet-4-6
LOG_GROUP="/aws/lambda/${SERVICE}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK_DIR="$(mktemp -d)"

echo "== SLA Guardian setup (region ${AWS_REGION}, account ${ACCOUNT}) =="

# ---------------------------------------------------------------------------
# 1. Lambda sla-demo-svc — logs exactly one JSON line per invocation.
#    v1 always "ok"; v2 fails ~60% of the time. The two published
#    versions differ by the FAIL_RATE env var baked at publish time.
# ---------------------------------------------------------------------------
cat > "${WORK_DIR}/lambda_function.py" <<'PY'
import json
import os
import random
import time


def handler(event, context):
    fail_rate = float(os.environ.get("FAIL_RATE", "0.0"))
    status = "error" if random.random() < fail_rate else "ok"
    latency_ms = random.randint(20, 400)
    # Exactly one JSON line per invocation — get_sla_status parses these.
    print(json.dumps({"status": status, "latency_ms": latency_ms}))
    time.sleep(latency_ms / 1000.0)
    return {"status": status, "latency_ms": latency_ms}
PY

( cd "${WORK_DIR}" && zip -q function.zip lambda_function.py )

# Execution role for the demo Lambda itself (separate from the agent's
# scoped iam_policy.json — this one only needs basic logging).
LAMBDA_ROLE_NAME=sla-demo-svc-lambda-role
cat > "${WORK_DIR}/lambda-trust.json" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow", "Principal": {"Service": "lambda.amazonaws.com"},
     "Action": "sts:AssumeRole"}
  ]
}
JSON

aws iam create-role \
  --role-name "${LAMBDA_ROLE_NAME}" \
  --assume-role-policy-document "file://${WORK_DIR}/lambda-trust.json" >/dev/null
aws iam attach-role-policy \
  --role-name "${LAMBDA_ROLE_NAME}" \
  --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
LAMBDA_ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/${LAMBDA_ROLE_NAME}"

echo "waiting for IAM role to propagate..."
sleep 10

# Create the function (code = failing variant so v2 can be published
# straight after v1).
aws lambda create-function \
  --function-name "${SERVICE}" \
  --runtime python3.12 \
  --role "${LAMBDA_ROLE_ARN}" \
  --handler lambda_function.handler \
  --zip-file "fileb://${WORK_DIR}/function.zip" \
  --timeout 30 \
  --environment "Variables={FAIL_RATE=0.0}" >/dev/null
aws lambda wait function-active --function-name "${SERVICE}"

# Version 1 — always succeeds (FAIL_RATE=0.0, as created).
V1=$(aws lambda publish-version --function-name "${SERVICE}" \
  --description "always ok" --query Version --output text)

# Flip the env to the failing variant, then publish version 2.
aws lambda update-function-configuration \
  --function-name "${SERVICE}" \
  --environment "Variables={FAIL_RATE=0.6}" >/dev/null
aws lambda wait function-updated --function-name "${SERVICE}"
V2=$(aws lambda publish-version --function-name "${SERVICE}" \
  --description "fails ~60%" --query Version --output text)

# Alias live -> version 2 (the bad deploy).
if aws lambda get-alias --function-name "${SERVICE}" --name "${ALIAS}" >/dev/null 2>&1; then
  aws lambda update-alias --function-name "${SERVICE}" --name "${ALIAS}" \
    --function-version "${V2}" >/dev/null
else
  aws lambda create-alias --function-name "${SERVICE}" --name "${ALIAS}" \
    --function-version "${V2}" >/dev/null
fi

# ---------------------------------------------------------------------------
# 2. S3 bucket for incident reports.
# ---------------------------------------------------------------------------
if ! aws s3api head-bucket --bucket "${BUCKET}" >/dev/null 2>&1; then
  # us-east-1 is special-cased: no LocationConstraint allowed.
  aws s3api create-bucket --bucket "${BUCKET}" --region "${AWS_REGION}" >/dev/null
fi

# ---------------------------------------------------------------------------
# 3. Bedrock Guardrail (prompt-attack). Capture the printed id/version.
# ---------------------------------------------------------------------------
GUARDRAIL_OUT=$(cd "${HERE}" && python3 create_guardrail.py)
echo "${GUARDRAIL_OUT}"
BEDROCK_GUARDRAIL_ID=$(echo "${GUARDRAIL_OUT}" | awk '/BEDROCK_GUARDRAIL_ID:/ {print $2}')
BEDROCK_GUARDRAIL_VERSION=$(echo "${GUARDRAIL_OUT}" | awk '/BEDROCK_GUARDRAIL_VERSION:/ {print $2}')
export BEDROCK_GUARDRAIL_ID
export BEDROCK_GUARDRAIL_VERSION

# Substitute the real guardrail id into a working copy of the agent's
# scoped IAM policy (never mutate the checked-in iam_policy.json).
POLICY_FILE="${WORK_DIR}/iam_policy.resolved.json"
sed "s/REPLACE_WITH_GUARDRAIL_ID/${BEDROCK_GUARDRAIL_ID}/" \
  "${HERE}/iam_policy.json" > "${POLICY_FILE}"

# ---------------------------------------------------------------------------
# 4. Agent execution role from the scoped iam_policy.json.
# ---------------------------------------------------------------------------
cat > "${WORK_DIR}/agent-trust.json" <<'JSON'
{
  "Version": "2012-10-17",
  "Statement": [
    {"Effect": "Allow",
     "Principal": {"Service": "bedrock-agentcore.amazonaws.com"},
     "Action": "sts:AssumeRole"}
  ]
}
JSON

aws iam create-role \
  --role-name "${ROLE_NAME}" \
  --assume-role-policy-document "file://${WORK_DIR}/agent-trust.json" >/dev/null
aws iam put-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-name sla-guardian-scoped \
  --policy-document "file://${POLICY_FILE}" >/dev/null
AGENT_ROLE_ARN="arn:aws:iam::${ACCOUNT}:role/${ROLE_NAME}"

# ---------------------------------------------------------------------------
# 5. Echo every created resource id/ARN.
# ---------------------------------------------------------------------------
echo
echo "== created resources =="
echo "lambda_function       : ${SERVICE}"
echo "lambda_version_good   : ${V1}"
echo "lambda_version_bad    : ${V2}"
echo "lambda_alias          : ${ALIAS} -> version ${V2}"
echo "lambda_exec_role      : ${LAMBDA_ROLE_ARN}"
echo "log_group             : ${LOG_GROUP}"
echo "s3_bucket             : ${BUCKET}"
echo "guardrail_id          : ${BEDROCK_GUARDRAIL_ID}"
echo "guardrail_version     : ${BEDROCK_GUARDRAIL_VERSION}"
echo "agent_exec_role       : ${AGENT_ROLE_ARN}"
echo "model_id              : ${MODEL_ID}"
echo
echo "Export these before deploy / local run:"
echo "  export BUCKET=${BUCKET}"
echo "  export BEDROCK_GUARDRAIL_ID=${BEDROCK_GUARDRAIL_ID}"
echo "  export BEDROCK_GUARDRAIL_VERSION=${BEDROCK_GUARDRAIL_VERSION}"
echo
echo "setup complete."
