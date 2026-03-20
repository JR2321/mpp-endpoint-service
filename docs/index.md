# MPP Endpoint-as-a-Service

Turn any API into an MPP card-compatible endpoint in 5 minutes.

AI agents need to pay for things. The Machine Payments Protocol (MPP) lets them do that over HTTP using card payments. This service handles the protocol so you don't have to.

## How it works

```
Agent                    MPP Endpoint Service              Your API
  |                            |                              |
  |  GET /v1/acme/weather      |                              |
  |--------------------------->|                              |
  |                            |                              |
  |  402 + payment challenge   |                              |
  |<---------------------------|                              |
  |                            |                              |
  |  GET + encrypted card token|                              |
  |--------------------------->|                              |
  |                            |  decrypt token               |
  |                            |  charge card via acquirer     |
  |                            |  GET /weather                 |
  |                            |----------------------------->|
  |                            |           200 OK              |
  |                            |<-----------------------------|
  |  200 OK + receipt          |                              |
  |<---------------------------|                              |
```

Your API stays exactly as it is. The service sits in front, handles the MPP payment flow, charges the agent's card through your acquirer, and proxies the request to your API only after payment succeeds.

## Choose your integration

| Mode | Best for | Setup time |
|------|----------|------------|
| [**Proxy mode**](./quickstart-proxy.md) | Zero code changes. We host the endpoint. | 5 minutes |
| [**Middleware mode**](./quickstart-middleware.md) | Full control. You embed our SDK. | 15 minutes |

New to MPP? Start with [proxy mode](./quickstart-proxy.md).

## What's in these docs

- [Quickstart: Proxy mode](./quickstart-proxy.md) — Create a hosted MPP endpoint with zero code
- [Quickstart: Middleware mode](./quickstart-middleware.md) — Embed MPP into your own server
- [API Reference](./api-reference.md) — Manage endpoints, keys, and configuration
- [Gateway Adapters](./gateway-adapters.md) — For acquirers integrating their processing infrastructure
- [Error Reference](./errors.md) — Every error, what it means, and how to fix it
- [Testing & Sandbox](./testing.md) — Test the full payment flow without real charges
- [Concepts](./concepts.md) — How MPP card payments work under the hood
