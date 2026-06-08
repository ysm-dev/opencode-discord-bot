# opencode-discord-bot

## 0.1.0

### Minor Changes

- Include Discord message reaction counts in the model context.

## 0.0.11

### Patch Changes

- Split the Discord bridge into per-action tools with typed arguments and remove unsupported reaction removal, message edit/delete, and pin/unpin bridge actions.

## 0.0.10

### Patch Changes

- Reduce duplicate Discord user IDs in context prompts by adding a participants roster and omitting repeated author IDs from normal message headers.
