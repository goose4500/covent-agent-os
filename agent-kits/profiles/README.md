# Agent profiles

`covent-speed-operator.yaml` is the high-agency default for trusted internal Covent operators running in EC2/local speed mode. Explicit Slack invocation of this profile is treated as approval to proceed, while `env-guard` and `git-checkpoint` remain enabled for audit protection.

The other profiles are retained as legacy safe-mode profiles for conservative or supervised operation.
