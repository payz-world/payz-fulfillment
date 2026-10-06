# Payz Fulfillment

Fulfillment interfaces, purchase delivery, and encrypted storage for private purchase details.

## Overview

Payz Fulfillment connects the payment engine to purchase delivery. It provides a shared fulfillment adapter contract, invoice and delivery handling, protected purchase-access tokens, encrypted redemption details, and downloadable purchase documents.

## Architecture

The payment engine integrates through Payz's shared fulfillment interface, not adapter-specific response formats. The package supports provider configuration, purchase fulfillment and reconciliation, and secure customer delivery. Database persistence and purchase access rules remain in the consuming application.

Private purchase data and access tokens are encrypted with authenticated encryption derived from `SESSION_SECRET`. Access tokens are also stored as keyed hashes. Keep the server-side secret stable while encrypted purchase records need to be read; never expose it to a browser.

## Development

Use Node.js 22 or later and pnpm 10. This package depends on `payz-core`; keep these separate repositories in one pnpm workspace:

```sh
mkdir -p payz-fulfillment-development/repos
cd payz-fulfillment-development
git clone https://github.com/payz-world/payz-core.git repos/payz-core
git clone https://github.com/payz-world/payz-fulfillment.git repos/payz-fulfillment
cp repos/payz-fulfillment/development/package.json .
cp repos/payz-fulfillment/development/pnpm-workspace.yaml .
pnpm install
pnpm --filter payz-fulfillment typecheck
pnpm --filter payz-fulfillment test
```

When adding this package to another Payz service, add both checkouts to that service's existing workspace instead of creating another workspace.

## Configuration

Copy `.env.example` to a local environment file and set values only in the server-side environment:

- `SESSION_SECRET`: stable, high-entropy server secret used for private delivery encryption and access-token protection.
- `PAYZ_PROVIDER_ACCESS_TOKEN`: fulfillment adapter credential; never expose it in browser code or commit it.
- `PAYZ_FULFILLMENT_API_BASE_URL`: optional HTTPS endpoint override for controlled local testing.

Do not use production credentials or redemption data in tests. Never commit `.env` files, real credentials, access tokens, or purchase details.

## Testing

`pnpm --filter payz-fulfillment test` runs the private-delivery tests with local, test-only data. These tests do not create purchases or make live fulfillment requests. Typechecking and tests require no database or production connection.

## License

Licensed under [Apache-2.0](LICENSE).
