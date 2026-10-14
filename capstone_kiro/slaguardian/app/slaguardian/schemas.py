"""Incident-report schema and validator for the SLA Guardian capstone.

The agent must produce a verifiable audit artifact. ``IncidentReport``
describes that artifact; ``validate_report`` enforces its shape before
anything is written to S3 so a malformed report never becomes the
run's evidence.
"""
from dataclasses import dataclass
from typing import Optional


@dataclass
class IncidentReport:
    """Structured record of one SLA-evaluation run."""

    detected_at: str
    error_rate_before: float
    sla_threshold: float
    action_taken: str
    previous_version: Optional[str]
    new_version: Optional[str]
    status: str


# Required field -> accepted types. Optional versions may be None.
_REQUIRED_FIELDS = {
    "detected_at": (str,),
    "error_rate_before": (float, int),
    "sla_threshold": (float, int),
    "action_taken": (str,),
    "previous_version": (str, type(None)),
    "new_version": (str, type(None)),
    "status": (str,),
}


def validate_report(report: dict) -> dict:
    """Validate an incident report dict against the IncidentReport schema.

    Raises ValueError if a required field is missing, an unexpected
    field is present, or a field has the wrong type. Returns the report
    unchanged on success.

    Args:
        report: The candidate incident-report dictionary.
    """
    if not isinstance(report, dict):
        raise ValueError(
            f"report must be a dict, got {type(report).__name__}."
        )

    missing = [f for f in _REQUIRED_FIELDS if f not in report]
    if missing:
        raise ValueError(f"report is missing required field(s): {missing}.")

    unexpected = [k for k in report if k not in _REQUIRED_FIELDS]
    if unexpected:
        raise ValueError(f"report has unexpected field(s): {unexpected}.")

    for field, allowed_types in _REQUIRED_FIELDS.items():
        value = report[field]
        if not isinstance(value, allowed_types):
            allowed = "/".join(t.__name__ for t in allowed_types)
            raise ValueError(
                f"report field {field!r} must be {allowed}, got "
                f"{type(value).__name__}."
            )

    return report
