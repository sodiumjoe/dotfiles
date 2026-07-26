.[0] as $base | .[1] as $overlay |
($base * $overlay) |
.permissions.allow = ($base.permissions.allow + ($overlay.permissions.allow // [])) |
.permissions.deny = (($base.permissions.deny // []) + ($overlay.permissions.deny // [])) |
.permissions.ask = (($base.permissions.ask // []) + ($overlay.permissions.ask // [])) |
.enabledMcpjsonServers = (($base.enabledMcpjsonServers // []) + ($overlay.enabledMcpjsonServers // [])) |
.enabledPlugins = (($base.enabledPlugins // {}) * ($overlay.enabledPlugins // {}))