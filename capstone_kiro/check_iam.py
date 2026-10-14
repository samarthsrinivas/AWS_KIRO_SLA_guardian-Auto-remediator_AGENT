"""Build gate: fail if iam_policy.json contains any wildcard grant.

Flattens every Action and Resource value across all Statements and
rejects anything that widens blast radius:

  * a bare "*"                     (allow everything)
  * a service-wide "<service>:*"   (e.g. "s3:*", "lambda:*")

A fully-scoped ARN whose final segment is ":*" is ALLOWED — e.g. a
CloudWatch Logs log-group ARN ends in ":*" to cover its log streams
(``...:log-group:/aws/lambda/sla-demo-svc:*``). That is a scoped
resource, not a wildcard grant, so it must pass.

Exit 0 and print a PASS line when the policy is clean; print the
offending value and exit 1 otherwise. Any value equal to "*" MUST
make this script exit non-zero (that is the whole point of the gate).

Self-test: copy iam_policy.json, change a Resource to "*", and run
this script against the copy — it must exit 1 and name that value.
"""
import json
import re
import sys

POLICY_PATH = "iam_policy.json"

# Service-wide wildcard like "s3:*" / "lambda:*" / "logs:*".
_SERVICE_WIDE = re.compile(r"^[a-z0-9]+:\*$")


def _flatten(value):
    """Yield each scalar in a value that is a string or a list of strings."""
    if isinstance(value, str):
        yield value
    elif isinstance(value, list):
        for item in value:
            if isinstance(item, str):
                yield item


def _is_wildcard(value: str) -> bool:
    """True if value is a bare '*' or a service-wide '<service>:*' grant."""
    return value == "*" or bool(_SERVICE_WIDE.match(value))


def check(policy: dict) -> list:
    """Return the list of offending (field, value) wildcard grants."""
    offenders = []
    statements = policy.get("Statement")
    if isinstance(statements, dict):
        statements = [statements]
    for statement in (statements or []):
        if not isinstance(statement, dict):
            continue
        for field in ("Action", "Resource"):
            for value in _flatten(statement.get(field)):
                if _is_wildcard(value):
                    offenders.append((field, value))
    return offenders


def main(path: str = POLICY_PATH) -> int:
    try:
        with open(path) as f:
            policy = json.load(f)
    except (OSError, ValueError) as e:
        print(f"FAIL: could not load {path}: {e}")
        return 1

    offenders = check(policy)
    if offenders:
        for field, value in offenders:
            print(f'FAIL: wildcard {field} value not allowed: "{value}"')
        return 1

    print(f"PASS: {path} contains no wildcard Action or Resource values.")
    return 0


if __name__ == "__main__":
    path = sys.argv[1] if len(sys.argv) > 1 else POLICY_PATH
    sys.exit(main(path))
