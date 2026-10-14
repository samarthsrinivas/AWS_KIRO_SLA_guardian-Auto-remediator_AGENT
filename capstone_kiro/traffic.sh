#!/usr/bin/env bash
# traffic.sh — drive 30 invocations through the live alias of
# sla-demo-svc so the log group fills with fresh {status, latency_ms}
# lines for get_sla_status to read.
#
# NOTE: this is run by the HUMAN, not the agent. The agent only reads
# logs and (if breached) rolls the alias back; it never generates load.
set -euo pipefail

export AWS_REGION=us-east-1
export AWS_DEFAULT_REGION=us-east-1

SERVICE=sla-demo-svc
ALIAS=live
COUNT=30

echo "== invoking ${SERVICE}:${ALIAS} ${COUNT} times =="
for i in $(seq 1 "${COUNT}"); do
  # Invoke the live alias; discard the response payload (we only care
  # that the invocation logs a line). /dev/null is a throwaway outfile.
  aws lambda invoke \
    --function-name "${SERVICE}:${ALIAS}" \
    --payload '{}' \
    /dev/null >/dev/null
  echo -n "."
done
echo

# Give CloudWatch Logs a moment to flush so get_sla_status sees the
# just-generated events on the next agent invoke.
echo "waiting for logs to flush..."
sleep 10

echo "traffic complete (${COUNT} invocations)."
