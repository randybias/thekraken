# Test Mocks

## mock-pi.ts

A minimal TypeScript script that mimics the `pi` CLI surface for unit and integration tests.

### Usage

Spawn via `child_process.spawn()` with `tsx`:

```typescript
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const mockPiPath = resolve(__dirname, '../mocks/mock-pi.ts');

const proc = spawn('node', ['--import', 'tsx/esm', mockPiPath], {
  env: {
    ...process.env,
    MOCK_PI_SCENARIO: 'build-ok',
    KRAKEN_TEAM_DIR: '/path/to/team/dir',
    TNTC_ACCESS_TOKEN: 'test-token', // D6: required
    MOCK_PI_IDLE_TIMEOUT_MS: '100',
  },
});
```

### Scenarios

| MOCK_PI_SCENARIO | Behavior                                                     |
| ---------------- | ------------------------------------------------------------ |
| `build-ok`       | Reads mailbox, writes signals + outbound completion, exits 0 |
| `deploy-ok`      | Writes deploy completion signals + outbound, exits 0         |
| `idle-exit`      | Waits MOCK_PI_IDLE_TIMEOUT_MS then exits 0 (default: 100ms)  |
| `error`          | Writes error signal + outbound, exits 1                      |
| `token-expired`  | Writes re-auth outbound message, exits 0 (D6 clean fail)     |

### Environment Variables

| Var                       | Required    | Description                                       |
| ------------------------- | ----------- | ------------------------------------------------- |
| `MOCK_PI_SCENARIO`        | No          | Behavior scenario. Default: `idle-exit`           |
| `KRAKEN_TEAM_DIR`         | Yes for I/O | Path to team state directory                      |
| `TNTC_ACCESS_TOKEN`       | Yes (D6)    | User OIDC token (presence verified, never echoed) |
| `MOCK_PI_IDLE_TIMEOUT_MS` | No          | Idle timeout in ms. Default: 100                  |
