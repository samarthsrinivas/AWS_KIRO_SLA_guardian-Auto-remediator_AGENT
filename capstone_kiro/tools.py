"""The three SLA Guardian tools: detect, remediate, record.

Each tool validates its own arguments and returns an ``Error: ...``
string on any failure instead of raising — a single unhandled
exception in a tool would break the agent loop. boto3 clients are
always built with region_name="us-east-1": the default session
resolves region as None on this instance.
"""
import json
import os
import re
import time

import boto3
from strands import tool

import schemas

# Load config once at import, relative to this file (not the CWD).
_CONFIG_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "config.json")
with open(_CONFIG_PATH) as _f:
    config = json.load(_f)

# Max ONE rollback per run — enforced in code, not by the system prompt,
# so a prompt-injected instruction can never trigger a second rollback.
_rollback_done = False


@tool
def get_sla_status(service: str) -> dict:
    """Measure the recent error rate for a service and flag SLA breaches.

    Args:
        service: The service name; must equal the configured service.
    """
    try:
        service = (service or "").strip()
        if service != config["service"]:
            return f"Error: unknown service {service!r}; this agent only handles {config['service']!r}."

        logs = boto3.client("logs", region_name="us-east-1")
        start_time = int((time.time() - 300) * 1000)  # last 5 minutes, ms
        log_group = f"/aws/lambda/{config['service']}"

        invocations = 0
        errors = 0
        latencies = []

        # SECURITY: never return raw log text to the model. Logs are
        # untrusted input (prompt-injection risk); we parse them here
        # and expose only COMPUTED NUMBERS to the agent.
        paginator = logs.get_paginator("filter_log_events")
        for page in paginator.paginate(logGroupName=log_group, startTime=start_time):
            for event in (page.get("events") or []):
                message = (event.get("message") or "").strip()
                if not message:
                    continue
                try:
                    record = json.loads(message)
                except (ValueError, TypeError):
                    continue  # skip unparseable / malformed lines
                if not isinstance(record, dict):
                    continue
                invocations += 1
                if (record.get("status") or "") == "error":
                    errors += 1
                latency = record.get("latency_ms")
                if isinstance(latency, (int, float)):
                    latencies.append(latency)

        error_rate = (errors / invocations) if invocations else 0.0
        if latencies:
            ordered = sorted(latencies)
            idx = max(0, int(round(0.95 * (len(ordered) - 1))))
            p95_latency_ms = ordered[idx]
        else:
            p95_latency_ms = 0

        return {
            "invocations": invocations,
            "errors": errors,
            "error_rate": error_rate,
            "p95_latency_ms": p95_latency_ms,
            "breached": error_rate > config["sla_max_error_rate"],
        }
    except Exception as e:  # noqa: BLE001 — tools must never raise into the loop
        return f"Error: {e}"


@tool
def rollback_alias(service: str, target_version: str, reason: str) -> dict:
    """Roll a service alias back to a known-good version (max once per run).

    Args:
        service: The service name; must equal the configured service.
        target_version: Version to roll back to; must be known-good.
        reason: Short human-readable justification (<= 300 chars).
    """
    global _rollback_done
    try:
        service = (service or "").strip()
        target_version = (target_version or "").strip()
        reason = (reason or "").strip()

        if service != config["service"]:
            return f"Error: unknown service {service!r}; this agent only handles {config['service']!r}."
        if target_version not in config["known_good_versions"]:
            return f"Error: target_version {target_version!r} is not a known-good version."
        if not reason:
            return "Error: reason must not be empty."
        if len(reason) > 300:
            return f"Error: reason is too long ({len(reason)} chars); limit is 300."
        if _rollback_done:
            return "Error: a rollback has already been performed this run (max one per run)."

        lam = boto3.client("lambda", region_name="us-east-1")
        current = lam.get_alias(
            FunctionName=config["service"], Name=config["alias"]
        )
        previous_version = current.get("FunctionVersion") or ""
        if previous_version == target_version:
            return f"Error: alias {config['alias']!r} already points at version {target_version}."

        lam.update_alias(
            FunctionName=config["service"],
            Name=config["alias"],
            FunctionVersion=target_version,
        )
        _rollback_done = True
        return {"previous_version": previous_version, "new_version": target_version}
    except Exception as e:  # noqa: BLE001 — tools must never raise into the loop
        return f"Error: {e}"


@tool
def write_incident_report(incident_id: str, report: dict) -> str:
    """Write a validated incident report to S3 as the run's audit artifact.

    Args:
        incident_id: Report id matching ``^inc-[0-9]{8}-[a-z0-9]{6}$``.
        report: Incident-report dict (validated against the schema).
    """
    try:
        incident_id = (incident_id or "").strip()
        if not re.fullmatch(r"inc-[0-9]{8}-[a-z0-9]{6}", incident_id):
            return f"Error: incident_id {incident_id!r} does not match ^inc-[0-9]{{8}}-[a-z0-9]{{6}}$."

        try:
            report = schemas.validate_report(report)
        except ValueError as e:
            return f"Error: {e}"

        bucket = os.environ.get("BUCKET")
        if not bucket:
            return "Error: BUCKET environment variable is not set."

        s3 = boto3.client("s3", region_name="us-east-1")
        key = f"incidents/{incident_id}.json"
        s3.put_object(Bucket=bucket, Key=key, Body=json.dumps(report))
        return f"s3://{bucket}/{key}"
    except Exception as e:  # noqa: BLE001 — tools must never raise into the loop
        return f"Error: {e}"
