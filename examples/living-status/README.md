# Living status example

This sample keeps a customer import rollout current at one URL. It puts the present state,
risks, and next actions ahead of a chronological activity log.

[Open the official live example](https://derive.to/artifacts/customer-import-rollout-current-status-f49k4yvg).

```bash
derive publish --name "Baseline"
# Update status.md after feedback or new evidence, then:
derive publish --name "Decision update"
```

Suggested recurring update prompt:

> Update the pilot results, remove anything that is no longer current, and make sure every
> open risk has an owner and a next action.
