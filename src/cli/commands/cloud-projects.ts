import "reflect-metadata";
import { Group } from "../decorators.js";
import { ProjectsCommands } from "./projects.js";

/**
 * `ravi cloud projects` is the older name of `ravi projects`; same commands,
 * same Console calls. Kept so scripts and generated SDK calls keep working.
 */
@Group({
  name: "cloud.projects",
  description: "Alias of `ravi projects`: the organization's projects in Ravi Console",
  scope: "open",
})
export class CloudProjectsCommands extends ProjectsCommands {}
