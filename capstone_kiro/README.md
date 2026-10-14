# SLA Guardian

A minimal Amazon Bedrock AgentCore capstone. The agent detects an SLA
breach on a demo Lambda and auto-remediates by rolling its `live` alias
back to a known-good version, then writes an incident report to S3.

## Problem statement

Bad deploys breach SLAs before a human notices. Given a service name,
the agent measures the error rate over the last 5 minutes, compares it
to the SLA (error rate must stay below 5%), and if breached, rolls the
`live` alias back to the last known-good version. It writes an incident
report to S3.

Success = the incident report exists, the alias points to the good
version, and a second check shows the SLA restored. If the SLA is NOT
breached, the agent writes a report with `action_taken="none"` and does
not roll back.

## Tools (exactly three)

- **`get_sla_status(service)`** — reads the service's log group
  (`logs:FilterLogEvents`) and returns computed numbers only
  (`invocations, errors, error_rate, p95_latency_ms, breached`). Never
  returns raw log text to the model (logs are untrusted input, a
  prompt-injection risk). *Why it exists:* without it the agent cannot
  detect a breach.
- **`rollback_alias(service, target_version, reason)`** — points the
  `live` alias at a known-good version (`lambda:GetAlias` +
  `lambda:UpdateAlias`), at most once per run (enforced in code), only
  to a version in `known_good_versions`. *Why it exists:* without it
  this is a monitor, not a remediator.
- **`write_incident_report(incident_id, report)`** — writes the report
  JSON to `s3://$BUCKET/incidents/<incident_id>.json`
  (`s3:PutObject`). *Why it exists:* without it there is no verifiable
  artifact or audit trail.

All tools return a clear `Error: ...` string on validation failure
instead of raising, so one bad argument never breaks the agent loop.

## Security

The primary layer is a Bedrock Guardrail with a PROMPT_ATTACK filter
(inputStrength HIGH), created by `create_guardrail.py` and wired onto
the `BedrockModel` in `agent.py` via **both** `guardrail_id` and
`guardrail_version` (Strands silently drops the guardrail if either is
missing). Tool-level input validation is the defense-in-depth layer.

### IAM scoping note

`iam_policy.json` has **zero** wildcards — no value is `"*"` or
`"<service>:*"`. `check_iam.py` fails the build if a wildcard appears.

- `bedrock:InvokeModel` / `InvokeModelWithResponseStream` scoped to the
  explicit `us.anthropic.claude-sonnet-4-6` inference-profile ARN plus
  the three regional foundation-model ARNs it fronts.
- `bedrock:ApplyGuardrail` scoped to the exact guardrail ARN (the
  `REPLACE_WITH_GUARDRAIL_ID` placeholder is substituted by `setup.sh`
  with the id `create_guardrail.py` prints).
- `logs:FilterLogEvents` scoped to the `sla-demo-svc` log group ARN
  only.
- `lambda:GetAlias` / `lambda:UpdateAlias` scoped to the exact `live`
  alias ARN only.
- `s3:PutObject` scoped to the `incidents/` prefix only.
- **No `cloudwatch:GetMetricData`** — it does not support
  resource-level permissions and would force a `"*"` resource. The
  agent reads logs directly instead.

## Deploy

Deps are pinned in `requirements.txt`
(`strands-agents==1.56.0`, `strands-agents-tools==0.8.9`,
`bedrock-agentcore==1.23.1`, `boto3==1.43.98`). The model is
`us.anthropic.claude-sonnet-4-6`.

1. Provision the demo service, S3 bucket, guardrail, and scoped IAM
   role (region `us-east-1`):

   ```bash
   ./setup.sh
   ```

   It prints the guardrail id/version and the `BUCKET` name — export
   them for local runs and the deploy:

   ```bash
   export BUCKET=sla-guardian-incidents-463332366725-us-east-1
   export BEDROCK_GUARDRAIL_ID=<printed id>
   export BEDROCK_GUARDRAIL_VERSION=<printed version>
   ```

2. Create the AgentCore project (deploy without memory first — AWS best
   practice is to verify the runtime, then add memory as a second
   pass):

   ```bash
   agentcore create --project-name slaguardian --name slaguardian \
       --language Python --framework Strands --model-provider Bedrock \
       --memory none --protocol HTTP --build CodeZip
   cd slaguardian
   ```

3. Port this agent into the scaffold:
   - Copy the three tools from `tools.py` and append them to the
     `tools` list in `app/slaguardian/main.py`, keeping the
     `@app.entrypoint` wrapper.
   - Replace the default system prompt in `main.py` with the one from
     `agent.py`.
   - In `model/load.py`, build the `BedrockModel` with **both**
     `guardrail_id=os.environ.get("BEDROCK_GUARDRAIL_ID")` and
     `guardrail_version=os.environ.get("BEDROCK_GUARDRAIL_VERSION",
     "DRAFT")`.
   - Declare the runtime environment in `agentcore/agentcore.json`:

     ```json
     "environmentVariables": {
       "BUCKET": "sla-guardian-incidents-463332366725-us-east-1",
       "BEDROCK_GUARDRAIL_ID": "<your guardrail id>",
       "BEDROCK_GUARDRAIL_VERSION": "<your guardrail version>"
     }
     ```

   - Enable AgentCore observability (CloudWatch traces) for the runtime.

4. Test locally through the CLI dev server (port 8080 is the editor, so
   use 8081), then deploy:

   ```bash
   agentcore dev -p 8081
   agentcore deploy          # add -y to skip prompts
   ```

## Demo and Verify

Run these in order:

1. **IAM gate** — `python3 check_iam.py` passes (no wildcards).
2. **Setup + deploy** — `./setup.sh`, then `agentcore deploy`;
   `agentcore status` reports **READY**.
3. **Generate load** — `./traffic.sh` drives errors on the bad version
   (run by you, not the agent).
4. **Breach run** — `agentcore invoke '{"service": "sla-demo-svc"}'`:
   breach detected, alias rolled back to version 1, incident report
   written to S3.
5. **Restored run** — `./traffic.sh` again, then
   `agentcore invoke '{"service": "sla-demo-svc"}'`: no breach,
   `action_taken="none"`, no rollback.
6. **Validation / blast-radius** —
   `agentcore invoke '{"service": "prod-billing"}'`: the tool rejects
   the service (proves input validation and the single-service limit).
7. **Guardrail (optional)** — invoke an off-mandate prompt and confirm
   the guardrail blocks it (see `security_proof.py` with `RUN_LIVE=1`).

Inspect the artifact and the structured log without the author
present:

```bash
aws s3 ls s3://sla-guardian-incidents-463332366725-us-east-1/incidents/
agentcore logs --since 1h            # one JSON line per run
agentcore traces list                # tool calls per run
```

Each run emits exactly one structured JSON log line:
`{run_id, error_rate, breached, action_taken, tools_called, status}`.

## Cleanup (mandatory)

AgentCore and the demo resources accrue cost if left running:

```bash
# Remove the runtime (declarative — remove from config, deploy removal):
cd slaguardian
agentcore remove agent --name slaguardian -y
agentcore deploy -y
cd ..

# Tear down the demo service, guardrail, IAM roles, ECR repo, log
# group, and S3 objects (idempotent — safe to run twice):
./cleanup.sh
```
