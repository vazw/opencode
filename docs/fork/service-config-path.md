# Service config path (Maintained in Fork)

The CLI's service configuration file — which holds the service password — no longer lives in the opencode config tree.

**Contract:** the file resolves to `path.join(path.dirname(global.config), "service")` plus
`filename()`. On this host `global.config` is `~/.config/opencode`, so `~/.config/service/service.json`.
Channel filenames are unchanged (`service.json` for latest/beta/next, `service-local.json`,
`service-dev.json`). The registration file stays under `$XDG_STATE_HOME`
(`~/.local/state/opencode/service.json`): clients and children of the service look there, so it stays.

**Override:** `SERVICE_CONFIG_PATH` names a directory, must be absolute, must not end in `.json`;
anything else fails loudly instead of writing into a misnamed path. Read at call time and inherited
by the spawned service, so both sides resolve the same directory. `opencode debug paths service`
prints it.

**Migration:** the first read copies the previous config from `<config>/opencode/` — current channel
name first, then the older hashed name — into the new directory, creating it `0700`; the file stays
`0600`. The copy is exclusive, so the first source wins, and the old file is left intact: the CLI
never deletes or truncates it.

**Operator cleanup:** once `~/.config/service/` holds the same password, remove the old copy with
`rm ~/.config/opencode/service*.json`. Until then a live credential stays in the config tree.

**Downgrade:** an upstream build reads the old path and still finds the retained copy, so the password
survives unless the fork has since rewritten the new file; a divergence costs one client reconnect,
and `opencode service set password` regenerates it.

**Containment (open):** the config tree's edit denies and `config-auditor`'s `TARGET_ROOT` do not
cover the sibling `service/` directory, so the new path is unfenced and unaudited until the operator
adds an `external_directory` deny for it in `~/.config/opencode/opencode.jsonc`.
