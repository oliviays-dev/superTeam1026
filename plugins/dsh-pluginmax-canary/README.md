# dsh-pluginmax-canary

R0 contract canary for DSH Pluginmax. The host half verifies an out-of-tree bundle, a storage domain, a human command, an Agent tool, and an exact HTTP route. The browser half adds a Settings section and reads the same health endpoint.

Install it into a disposable profile with:

```sh
DSH_HOME="$PWD/.tmp/dsh-home" node vendor/deepseek-harness/apps/cli/lib/bin.js plugin --profile pluginmax add "$PWD/plugins/dsh-pluginmax-canary"
```
