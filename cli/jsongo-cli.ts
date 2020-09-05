#!/usr/bin/env node

import yargs from "yargs";

yargs
  .commandDir("cmds", {
    visit: (commandModule) => commandModule.default,
  })
  .demandCommand()
  .scriptName("jsongo")
  .help().argv;
