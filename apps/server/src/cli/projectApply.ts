import { TrimmedNonEmptyString, type Project } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const ProjectManifest = Schema.Struct({
  schemaVersion: Schema.Literal(1),
  projects: Schema.Array(
    Schema.Struct({
      path: TrimmedNonEmptyString,
      // Omitted: the title is set when the project is created and left alone after that.
      title: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
});
export type ProjectManifest = typeof ProjectManifest.Type;

export interface DesiredProject {
  readonly workspaceRoot: string;
  readonly title: string | undefined;
  readonly defaultTitle: string;
}

export type ProjectApplyAction =
  | { readonly kind: "add"; readonly workspaceRoot: string; readonly title: string }
  | { readonly kind: "rename"; readonly project: Project; readonly title: string }
  | { readonly kind: "remove"; readonly project: Project };

export function planProjectApply(input: {
  readonly projects: ReadonlyArray<Project>;
  readonly desired: ReadonlyArray<DesiredProject>;
  readonly prune: boolean;
}): ReadonlyArray<ProjectApplyAction> {
  const active = input.projects.filter((project) => project.deletedAt === null);
  const byRoot = new Map(active.map((project) => [project.workspaceRoot, project]));
  const actions: Array<ProjectApplyAction> = [];

  for (const desired of input.desired) {
    const existing = byRoot.get(desired.workspaceRoot);
    if (existing === undefined) {
      actions.push({
        kind: "add",
        workspaceRoot: desired.workspaceRoot,
        title: desired.title ?? desired.defaultTitle,
      });
    } else if (desired.title !== undefined && desired.title !== existing.title) {
      actions.push({ kind: "rename", project: existing, title: desired.title });
    }
  }

  if (input.prune) {
    const desiredRoots = new Set(input.desired.map((desired) => desired.workspaceRoot));
    for (const project of active) {
      if (!desiredRoots.has(project.workspaceRoot)) {
        actions.push({ kind: "remove", project });
      }
    }
  }

  return actions;
}

export function describeProjectApplyAction(action: ProjectApplyAction): string {
  switch (action.kind) {
    case "add":
      return `add ${action.workspaceRoot} (${action.title})`;
    case "rename":
      return `rename ${action.project.id} at ${action.project.workspaceRoot}: ${action.project.title} -> ${action.title}`;
    case "remove":
      return `remove ${action.project.id} (${action.project.title}) at ${action.project.workspaceRoot}`;
  }
}
