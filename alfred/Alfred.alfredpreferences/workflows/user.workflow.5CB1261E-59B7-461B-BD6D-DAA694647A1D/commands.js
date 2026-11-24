function run(argv) {
  const query = (argv[0] || "").trim().toLowerCase();
  const commands = [
    { name: "toggle", title: "Toggle playback", subtitle: "Play or pause the current track", aliases: ["playpause"] },
    { name: "play", title: "Play", subtitle: "Resume playback", aliases: ["resume"] },
    { name: "pause", title: "Pause", subtitle: "Pause the current track", aliases: [] },
    { name: "next", title: "Next track", subtitle: "Skip to the next track", aliases: [] },
    { name: "prev", title: "Previous track", subtitle: "Go to the previous track", aliases: ["previous", "back"] },
    { name: "status", title: "Now playing", subtitle: "Show the current track and playback state", aliases: [] },
  ];
  const exact = commands.filter(command => [command.name, ...command.aliases].includes(query));
  const matches = exact.length
    ? exact
    : commands.filter(command => [command.name, ...command.aliases].some(name => name.startsWith(query)));
  const items = matches.map(command => ({
    uid: command.name,
    title: command.title,
    subtitle: command.subtitle,
    arg: command.name,
    autocomplete: command.name,
    valid: true,
  }));
  if (!items.length) {
    items.push({
      title: "Unknown YouTube Music command",
      subtitle: "Use play, pause, next, prev, toggle, or status",
      valid: false,
    });
  }
  return JSON.stringify({ items });
}