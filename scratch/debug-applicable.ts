import {
  detectHost,
  detectAvailableCommands,
  checkApplicability,
} from "@rckflr/agent-skills-cli";

const host = detectHost();
console.log("os:", host.os, "arch:", host.arch);
const cmds = detectAvailableCommands(["rg", "curl", "jq", "gh", "echo"]);
console.log("commands probed → available:", Array.from(cmds));
const full = { ...host, shellCommandsAvailable: cmds };
console.log("rg required:", checkApplicability({ shell_commands_present: ["rg"] }, full));
console.log("curl required:", checkApplicability({ shell_commands_present: ["curl"] }, full));
console.log("echo required:", checkApplicability({ shell_commands_present: ["echo"] }, full));
