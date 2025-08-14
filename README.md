# escreg

Welcome to your new AlgoKit project!

This is your workspace root. A `workspace` in AlgoKit is an orchestrated collection of standalone projects (backends, smart contracts, frontend apps and etc).

By default, `projects_root_path` parameter is set to `projects`. Which instructs AlgoKit CLI to create a new directory under `projects` directory when new project is instantiated via `algokit init` at the root of the workspace.

## Projects

This workspace contains the following projects:

- **escreg**: Smart contract implementation
- **ts-sdk**: TypeScript SDK for interacting with the smart contract
- **client**: CLI client for the escreg smart contract

## Getting Started

To get started refer to `README.md` files in respective sub-projects in the `projects` directory.

### CLI Client

The CLI client provides easy-to-use commands for registering and looking up application IDs:

```bash
cd projects/client
npm install
npm run build
npm start register 12345 --app-id 67890 --mnemonic "your mnemonic here"
npm start lookup "A7NMWS3NT3IUDMLVO26ULGXGIIOUQ3ND2TXSER6EBGRZNOBOUIQXHIBGDE" --app-id 67890
```

See the [client README](projects/client/README.md) for detailed usage instructions.

To learn more about algokit, visit [documentation](https://github.com/algorandfoundation/algokit-cli/blob/main/docs/algokit.md).

### GitHub Codespaces

To get started execute:

1. `algokit generate devcontainer` - invoking this command from the root of this repository will create a `devcontainer.json` file with all the configuration needed to run this project in a GitHub codespace. [Run the repository inside a codespace](https://docs.github.com/en/codespaces/getting-started/quickstart) to get started.
2. `algokit init` - invoke this command inside a github codespace to launch an interactive wizard to guide you through the process of creating a new AlgoKit project

Powered by [Copier templates](https://copier.readthedocs.io/en/stable/).
