#!/usr/bin/env bash
# cleanup.sh — tear down everything setup.sh and the deploy created.
# Idempotent: every deletion tolerates a missing resource, so running
# this twice is safe and the second run is a no-op. Deliberately NOT
# using `set -e` — a NotFound must not abort the rest of the teardown.
set -uo pipefail

export AWS_REGION=us-east-1
export AWS_DEFAULT_REGION=us-east-1

ACCOUNT=463332366725
SERVICE=sla-demo-svc
ALIAS=live
ROLE_NAME=sla-guardian-exec-role
LAMBDA_ROLE_NAME=sla-demo-svc-lambda-role
BUCKET=sla-guardian-incidents-463332366725-us-east-1
LOG_GROUP="/aws/lambda/${SERVICE}"
AGENTCORE_PROJECT=slaguardian
AGENTCORE_AGENT=slaguardian
ECR_REPO="bedrock-agentcore-${AGENTCORE_AGENT}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "== SLA Guardian cleanup (region ${AWS_REGION}) =="

# ---------------------------------------------------------------------------
# 1. AgentCore runtime — declarative: remove from config, then deploy
#    the removal. Guarded so a missing project dir does not error.
# ---------------------------------------------------------------------------
if [ -d "${HERE}/${AGENTCORE_PROJECT}" ]; then
  ( cd "${HERE}/${AGENTCORE_PROJECT}" \
    && agentcore remove agent --name "${AGENTCORE_AGENT}" -y \
    && agentcore deploy -y ) \
    || echo "  (agentcore runtime already removed or project absent)"
else
  echo "  (no agentcore project dir at ${AGENTCORE_PROJECT}; skipping)"
fi

# ---------------------------------------------------------------------------
# 2. Bedrock guardrail(s) named sla-guardian-guardrail.
# ---------------------------------------------------------------------------
GUARDRAIL_IDS=$(aws bedrock list-guardrails \
  --query "guardrails[?name=='sla-guardian-guardrail'].id" \
  --output text 2>/dev/null || true)
for gid in ${GUARDRAIL_IDS}; do
  aws bedrock delete-guardrail --guardrail-identifier "${gid}" >/dev/null 2>&1 \
    && echo "  deleted guardrail ${gid}" \
    || echo "  guardrail ${gid} already gone"
done

# ---------------------------------------------------------------------------
# 3. IAM roles — detach managed + delete inline policies first.
# ---------------------------------------------------------------------------
delete_role() {
  local role="$1"
  for pol in $(aws iam list-attached-role-policies --role-name "${role}" \
      --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null || true); do
    aws iam detach-role-policy --role-name "${role}" --policy-arn "${pol}" >/dev/null 2>&1 || true
  done
  for inline in $(aws iam list-role-policies --role-name "${role}" \
      --query 'PolicyNames[]' --output text 2>/dev/null || true); do
    aws iam delete-role-policy --role-name "${role}" --policy-name "${inline}" >/dev/null 2>&1 || true
  done
  aws iam delete-role --role-name "${role}" >/dev/null 2>&1 \
    && echo "  deleted role ${role}" \
    || echo "  role ${role} already gone"
}
delete_role "${ROLE_NAME}"
delete_role "${LAMBDA_ROLE_NAME}"

# ---------------------------------------------------------------------------
# 4. ECR repo created by agentcore deploy.
# ---------------------------------------------------------------------------
aws ecr delete-repository --repository-name "${ECR_REPO}" --force >/dev/null 2>&1 \
  && echo "  deleted ECR repo ${ECR_REPO}" \
  || echo "  ECR repo ${ECR_REPO} already gone"

# ---------------------------------------------------------------------------
# 5. Lambda function + its log group.
# ---------------------------------------------------------------------------
aws lambda delete-function --function-name "${SERVICE}" >/dev/null 2>&1 \
  && echo "  deleted lambda ${SERVICE}" \
  || echo "  lambda ${SERVICE} already gone"
aws logs delete-log-group --log-group-name "${LOG_GROUP}" >/dev/null 2>&1 \
  && echo "  deleted log group ${LOG_GROUP}" \
  || echo "  log group ${LOG_GROUP} already gone"

# ---------------------------------------------------------------------------
# 6. S3 — empty the incidents/ prefix, then delete the bucket.
# ---------------------------------------------------------------------------
if aws s3api head-bucket --bucket "${BUCKET}" >/dev/null 2>&1; then
  aws s3 rm "s3://${BUCKET}/incidents/" --recursive >/dev/null 2>&1 || true
  aws s3 rm "s3://${BUCKET}" --recursive >/dev/null 2>&1 || true
  aws s3api delete-bucket --bucket "${BUCKET}" >/dev/null 2>&1 \
    && echo "  deleted bucket ${BUCKET}" \
    || echo "  bucket ${BUCKET} not deletable (may be non-empty)"
else
  echo "  bucket ${BUCKET} already gone"
fi

echo
echo "cleanup complete (safe to run again)."
