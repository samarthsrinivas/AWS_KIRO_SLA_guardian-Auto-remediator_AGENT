SLA Guardian — Auto-Remediator Agent
An AI agent built with Kiro on AWS that watches service health against SLA targets and automatically fixes common problems before they become SLA breaches.
> Built as the capstone project for the AWS Kiro workshop.
---
What it does
SLA Guardian runs a continuous detect → diagnose → remediate → report loop:
Detect: monitors service metrics (latency, error rate, availability) against defined SLA thresholds. <!-- TODO: confirm metric sources, e.g. CloudWatch -->
Diagnose: when a threshold is at risk, the agent analyzes the signals to identify the likely cause.
Remediate: applies a pre-approved fix, such as restarting a service, scaling capacity, or rolling back a bad deploy. <!-- TODO: list the actions your agent actually performs -->
Report: logs what happened and what action was taken, so every remediation is auditable.
Repository structure
```
capstone_kiro/
├── agent.py          # Main entry point: runs the SLA Guardian agent
├── slaguardian/      # Core package: monitoring, diagnosis, and remediation logic
├── .agents/          # Kiro agent configuration
├── check_iam.py      # Verifies the AWS IAM permissions the agent needs
├── cleanup.sh        # Tears down AWS resources created by the project
└── tests/            # Pytest test suite  <!-- TODO: confirm folder name -->
```
Prerequisites
Python 3.10+ <!-- TODO: confirm version -->
An AWS account with credentials configured (`aws configure` or environment variables)
IAM permissions for the services the agent monitors and remediates
Kiro (optional, for editing and running the agent workflow)
Setup
```bash
git clone https://github.com/samarthsrinivas/AWS_KIRO_SLA_guardian-Auto-remediator_AGENT.git
cd AWS_KIRO_SLA_guardian-Auto-remediator_AGENT/capstone_kiro

python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt   # TODO: add requirements.txt if missing
```
Check that your AWS credentials have the required permissions:
```bash
python check_iam.py
```
Usage
Run the agent:
```bash
python agent.py
```
<!-- TODO: add any CLI flags, config files, or environment variables, e.g.
export AWS_REGION=us-east-1
Running tests
```bash
pytest
```
Cleanup
To avoid ongoing AWS charges, remove the resources the project created:
```bash
./cleanup.sh
```
Safety and design notes
Least privilege: the agent should only hold the IAM permissions that `check_iam.py` verifies.
Allow-listed actions: remediation is limited to a predefined set of safe actions. The agent does not run arbitrary commands.
Auditability: every detection and remediation is logged for review.
No secrets in the repo: credentials come from your AWS environment, never from code.
Tech stack
Kiro: agentic IDE used to build and orchestrate the agent
AWS: monitored infrastructure and remediation targets <!-- TODO: e.g. CloudWatch, Lambda, EC2, ECS -->
Python: agent and remediation logic
Pytest: testing
Author
Samarth Srinivas · GitHub
