import {
  AuthStandardClientScopes,
  CommandId,
  EnvironmentHttpApi,
  EnvironmentHttpCommonError,
  type ProjectMutation,
  type ProjectSnapshot,
  ProjectId,
} from "@t3tools/contracts";
import * as Console from "effect/Console";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as References from "effect/References";
import * as Schema from "effect/Schema";
import { Argument, Command, Flag, GlobalFlag } from "effect/cli";
import { FetchHttpClient, HttpClient, HttpClientError } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { parse as parseYaml } from "yaml";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ServerOwnership from "../serverOwnership.ts";
import type * as RuntimeLayer from "../orchestration-v2/runtimeLayer.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectFaviconResolver from "../project/ProjectFaviconResolver.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as ProjectService from "../project/ProjectService.ts";
import { projectMutationOperation } from "../project/ProjectMutation.ts";
import * as T3ProjectFileLoader from "../project/T3ProjectFileLoader.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import {
  clearPersistedServerRuntimeState,
  readPersistedServerRuntimeState,
} from "../serverRuntimeState.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { type CliAuthLocationFlags, projectLocationFlags, resolveCliAuthConfig } from "./config.ts";
import {
  type DesiredProject,
  describeProjectApplyAction,
  planProjectApply,
  type ProjectApplyAction,
  ProjectManifest,
} from "./projectApply.ts";

type ProjectMutationTarget = {
  readonly id: ProjectId;
  readonly title: string;
  readonly workspaceRoot: string;
};

type ProjectCommandExecutionMode = "live" | "offline";
type ProjectCliDispatchCommand = ProjectMutation;

const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);

export class ProjectCommandIdGenerationError extends Schema.TaggedError<ProjectCommandIdGenerationError>()(
  "ProjectCommandIdGenerationError",
  {
    operation: Schema.Literal("generateProjectCommandId"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to generate a project command identifier.";
  }
}

export class ProjectLiveServerDeclaredResponseError extends Schema.TaggedError<ProjectLiveServerDeclaredResponseError>()(
  "ProjectLiveServerDeclaredResponseError",
  {
    operation: Schema.Literal("callLiveServer"),
    code: Schema.String,
    traceId: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Server request failed (${this.code}, trace ${this.traceId}).`;
  }
}

export class ProjectLiveServerUndeclaredStatusError extends Schema.TaggedError<ProjectLiveServerUndeclaredStatusError>()(
  "ProjectLiveServerUndeclaredStatusError",
  {
    operation: Schema.Literal("callLiveServer"),
    status: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Server request failed with undeclared status ${this.status}.`;
  }
}

export class ProjectLiveServerRequestError extends Schema.TaggedError<ProjectLiveServerRequestError>()(
  "ProjectLiveServerRequestError",
  {
    operation: Schema.Literal("callLiveServer"),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Failed to call the running server.";
  }
}

export class ProjectTitleEmptyError extends Schema.TaggedError<ProjectTitleEmptyError>()(
  "ProjectTitleEmptyError",
  {
    operation: Schema.Literal("validateProjectTitle"),
    title: Schema.String,
  },
) {
  override get message(): string {
    return "Project title cannot be empty.";
  }
}

export class ProjectIdentifierEmptyError extends Schema.TaggedError<ProjectIdentifierEmptyError>()(
  "ProjectIdentifierEmptyError",
  {
    operation: Schema.Literal("resolveProjectTarget"),
    identifier: Schema.String,
  },
) {
  override get message(): string {
    return "Project identifier cannot be empty.";
  }
}

export class ProjectNotFoundError extends Schema.TaggedError<ProjectNotFoundError>()(
  "ProjectNotFoundError",
  {
    operation: Schema.Literal("resolveProjectTarget"),
    identifier: Schema.String,
    normalizedWorkspaceRoot: Schema.optional(Schema.String),
    activeProjectCount: Schema.Number,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `No active project found for '${this.identifier}'.`;
  }
}

export class ProjectAlreadyExistsError extends Schema.TaggedError<ProjectAlreadyExistsError>()(
  "ProjectAlreadyExistsError",
  {
    operation: Schema.Literal("addProject"),
    projectId: ProjectId,
    workspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `An active project already exists for '${this.workspaceRoot}'.`;
  }
}

export class ProjectManifestReadError extends Schema.TaggedError<ProjectManifestReadError>()(
  "ProjectManifestReadError",
  {
    operation: Schema.Literal("readProjectManifest"),
    manifestPath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to read project manifest '${this.manifestPath}'.`;
  }
}

export class ProjectManifestInvalidError extends Schema.TaggedError<ProjectManifestInvalidError>()(
  "ProjectManifestInvalidError",
  {
    operation: Schema.Literal("decodeProjectManifest"),
    manifestPath: Schema.String,
    detail: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Invalid project manifest '${this.manifestPath}': ${this.detail}`;
  }
}

export class ProjectManifestDuplicatePathError extends Schema.TaggedError<ProjectManifestDuplicatePathError>()(
  "ProjectManifestDuplicatePathError",
  {
    operation: Schema.Literal("decodeProjectManifest"),
    workspaceRoot: Schema.String,
  },
) {
  override get message(): string {
    return `Project manifest lists '${this.workspaceRoot}' more than once.`;
  }
}

export const ProjectCommandError = Schema.Union([
  ProjectCommandIdGenerationError,
  ProjectLiveServerDeclaredResponseError,
  ProjectLiveServerUndeclaredStatusError,
  ProjectLiveServerRequestError,
  ProjectTitleEmptyError,
  ProjectIdentifierEmptyError,
  ProjectNotFoundError,
  ProjectAlreadyExistsError,
  ProjectManifestReadError,
  ProjectManifestInvalidError,
  ProjectManifestDuplicatePathError,
]);
export type ProjectCommandError = typeof ProjectCommandError.Type;

function projectCommandErrorFromLiveServerRequest(cause: unknown): ProjectCommandError {
  if (isEnvironmentHttpCommonError(cause)) {
    return new ProjectLiveServerDeclaredResponseError({
      operation: "callLiveServer",
      code: cause.code,
      traceId: cause.traceId,
      cause,
    });
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    return new ProjectLiveServerUndeclaredStatusError({
      operation: "callLiveServer",
      status: cause.response.status,
      cause,
    });
  }

  return new ProjectLiveServerRequestError({ operation: "callLiveServer", cause });
}

const projectCommandUuid = SecureRandom.SecureRandom.pipe(
  Effect.flatMap((random) => random.uuidV4()),
  Effect.mapError(
    (cause) =>
      new ProjectCommandIdGenerationError({
        operation: "generateProjectCommandId",
        cause,
      }),
  ),
);

const makeProjectCliRuntimeLayer = (layerProjectService: typeof RuntimeLayer.layerProjectService) =>
  layerProjectService.pipe(
    Layer.provideMerge(ProjectEnrichmentService.layer),
    Layer.provideMerge(RepositoryIdentityResolver.layer),
    Layer.provideMerge(
      ProjectFaviconResolver.layer.pipe(
        Layer.provide(WorkspacePaths.layer),
        Layer.provide(T3ProjectFileLoader.layer),
      ),
    ),
    Layer.provideMerge(WorkspacePaths.layer),
    Layer.provideMerge(
      ServerSettings.layer.pipe(
        Layer.provide(Layer.merge(ServerSecretStore.layer, ManagedPolicy.layer)),
      ),
    ),
    Layer.provideMerge(SqlitePersistence.layerConfig),
  );

const PROJECT_CLI_LIVE_SERVER_PROBE_TIMEOUT = Duration.seconds(1);
const PROJECT_CLI_LIVE_SERVER_REQUEST_TIMEOUT = Duration.seconds(10);
const withProjectCliSessionToken = <A, E, R>(
  environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
  run: (token: string) => Effect.Effect<A, E, R>,
) =>
  Effect.acquireUseRelease(
    environmentAuth.issueSession({
      scopes: AuthStandardClientScopes,
      label: "t3 project cli",
    }),
    (issued) => run(issued.token),
    (issued) => environmentAuth.revokeSession(issued.sessionId).pipe(Effect.ignore({ log: true })),
  );

const makeLiveServerClient = (origin: string) =>
  HttpApiClient.make(EnvironmentHttpApi, {
    baseUrl: origin,
  });

const normalizeWorkspaceRootForProjectCommand = Effect.fn(
  "normalizeWorkspaceRootForProjectCommand",
)(function* (workspaceRoot: string) {
  const workspacePaths = yield* WorkspacePaths.WorkspacePaths;
  return yield* workspacePaths.normalizeWorkspaceRoot(workspaceRoot);
});

const resolveProjectTitle = Effect.fn("resolveProjectTitle")(function* (
  workspaceRoot: string,
  explicitTitle?: string,
) {
  if (explicitTitle !== undefined) {
    const trimmed = explicitTitle.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
    return yield* new ProjectTitleEmptyError({
      operation: "validateProjectTitle",
      title: explicitTitle,
    });
  }

  const path = yield* Path.Path;
  const basename = path.basename(workspaceRoot).trim();
  return basename.length > 0 ? basename : "project";
});

const findActiveProjectTarget = Effect.fn("findActiveProjectTarget")(function* (input: {
  readonly snapshot: ProjectSnapshot;
  readonly identifier: string;
}) {
  const trimmedIdentifier = input.identifier.trim();
  if (trimmedIdentifier.length === 0) {
    return yield* new ProjectIdentifierEmptyError({
      operation: "resolveProjectTarget",
      identifier: input.identifier,
    });
  }

  const activeProjects = input.snapshot.projects.filter((project) => project.deletedAt === null);
  const exactIdMatch = activeProjects.find((project) => project.id === trimmedIdentifier);
  if (exactIdMatch) {
    return {
      id: exactIdMatch.id,
      title: exactIdMatch.title,
      workspaceRoot: exactIdMatch.workspaceRoot,
    } satisfies ProjectMutationTarget;
  }

  const normalizedWorkspaceRootResult = yield* Effect.result(
    normalizeWorkspaceRootForProjectCommand(trimmedIdentifier),
  );
  // A stored workspace path still identifies its project after the directory is gone, so a
  // relative or trailing-slash path resolves the same way it would while the directory exists.
  const normalizedWorkspaceRoot =
    normalizedWorkspaceRootResult._tag === "Success"
      ? normalizedWorkspaceRootResult.success
      : normalizedWorkspaceRootResult.failure.normalizedWorkspaceRoot;

  const exactWorkspaceMatch = activeProjects.find(
    (project) => project.workspaceRoot === normalizedWorkspaceRoot,
  );

  const resolved = exactWorkspaceMatch;
  if (!resolved) {
    return yield* new ProjectNotFoundError({
      operation: "resolveProjectTarget",
      identifier: trimmedIdentifier,
      activeProjectCount: activeProjects.length,
      normalizedWorkspaceRoot,
      ...(normalizedWorkspaceRootResult._tag === "Failure"
        ? { cause: normalizedWorkspaceRootResult.failure }
        : {}),
    });
  }

  return {
    id: resolved.id,
    title: resolved.title,
    workspaceRoot: resolved.workspaceRoot,
  } satisfies ProjectMutationTarget;
});

const fetchLiveOrchestrationSnapshot = Effect.fn("project.fetchLiveOrchestrationSnapshot")(
  function* (origin: string, bearerToken: string, _timeout?: Duration.Duration) {
    const client = yield* makeLiveServerClient(origin);
    return yield* client.projects.snapshot({
      headers: { authorization: `Bearer ${bearerToken}` },
    });
  },
  (effect, _origin, _bearerToken, timeout = PROJECT_CLI_LIVE_SERVER_REQUEST_TIMEOUT) =>
    effect.pipe(Effect.timeout(timeout), Effect.mapError(projectCommandErrorFromLiveServerRequest)),
);

const dispatchLiveOrchestrationCommand = Effect.fn("project.dispatchLiveOrchestrationCommand")(
  function* (origin: string, bearerToken: string, command: ProjectCliDispatchCommand) {
    const client = yield* makeLiveServerClient(origin);
    yield* client.projects.mutate({
      headers: { authorization: `Bearer ${bearerToken}` },
      payload: command,
    } as Parameters<typeof client.projects.mutate>[0]);
  },
  (effect, _origin, _bearerToken, _command) =>
    effect.pipe(
      Effect.timeout(PROJECT_CLI_LIVE_SERVER_REQUEST_TIMEOUT),
      Effect.mapError(projectCommandErrorFromLiveServerRequest),
    ),
);

const getOfflineSnapshot = Effect.fn("getOfflineSnapshot")(function* () {
  const projects = yield* ProjectService.ProjectService;
  return yield* projects.snapshot;
});

const tryResolveLiveProjectExecutionMode = Effect.fn("tryResolveLiveProjectExecutionMode")(
  function* (
    environmentAuth: EnvironmentAuth.EnvironmentAuth["Service"],
    config: ServerConfig.ServerConfig["Service"],
  ) {
    const runtimeState = yield* readPersistedServerRuntimeState(config.serverRuntimeStatePath);
    if (Option.isNone(runtimeState)) {
      return Option.none<{ readonly origin: string }>();
    }

    const attempt = withProjectCliSessionToken(environmentAuth, (token) =>
      fetchLiveOrchestrationSnapshot(
        runtimeState.value.origin,
        token,
        PROJECT_CLI_LIVE_SERVER_PROBE_TIMEOUT,
      ).pipe(
        Effect.as({
          origin: runtimeState.value.origin,
        }),
      ),
    );

    const attempted = yield* Effect.result(attempt);
    if (attempted._tag === "Success") {
      return Option.some(attempted.success);
    }

    yield* Effect.logDebug("Failed to connect to the persisted project CLI server.", {
      origin: runtimeState.value.origin,
      cause: attempted.failure,
    });
    return Option.none<{ readonly origin: string }>();
  },
);

const runProjectMutation = Effect.fn("runProjectMutation")(function* (
  flags: CliAuthLocationFlags,
  run: (input: {
    readonly snapshot: ProjectSnapshot;
    readonly dispatch: (
      command: ProjectCliDispatchCommand,
    ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
    readonly mode: ProjectCommandExecutionMode;
  }) => Effect.Effect<
    string,
    Error,
    | SecureRandom.SecureRandom
    | FileSystem.FileSystem
    | HttpClient.HttpClient
    | Path.Path
    | WorkspacePaths.WorkspacePaths
  >,
) {
  const logLevel = yield* GlobalFlag.LogLevel;
  const config = yield* resolveCliAuthConfig(flags, logLevel);
  const minimumLogLevel = config.logLevel;

  return yield* Effect.gen(function* () {
    const environmentAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const liveMode = yield* tryResolveLiveProjectExecutionMode(environmentAuth, config);

    if (Option.isSome(liveMode)) {
      return yield* withProjectCliSessionToken(environmentAuth, (token) =>
        Effect.gen(function* () {
          const snapshot = yield* fetchLiveOrchestrationSnapshot(liveMode.value.origin, token);
          const output = yield* run({
            snapshot,
            dispatch: (command) =>
              dispatchLiveOrchestrationCommand(liveMode.value.origin, token, command),
            mode: "live",
          });
          yield* Console.log(output);
        }),
      );
    }

    // Before ownership and clearing, so a failed import leaves server state alone.
    const { layerProjectService } = yield* Effect.promise(
      () => import("../orchestration-v2/runtimeLayer.ts"),
    );
    const layerOfflineRuntime = makeProjectCliRuntimeLayer(layerProjectService).pipe(
      Layer.provide(ServerConfig.layer(config)),
      Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
    );

    // An unreachable server may still be running; never write behind it.
    yield* ServerOwnership.acquireServerOwnership(config.serverRuntimeStatePath).pipe(
      Effect.provide(ProcessRunner.layer),
    );
    yield* clearPersistedServerRuntimeState(config.serverRuntimeStatePath);
    return yield* Effect.gen(function* () {
      const snapshot = yield* getOfflineSnapshot();
      const projects = yield* ProjectService.ProjectService;
      const output = yield* run({
        snapshot,
        dispatch: (command) => projectMutationOperation(projects, command).pipe(Effect.asVoid),
        mode: "offline",
      });
      yield* Console.log(output);
    }).pipe(Effect.provide(layerOfflineRuntime));
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(EnvironmentAuth.layerRuntime, WorkspacePaths.layer).pipe(
        Layer.provideMerge(FetchHttpClient.layer),
        Layer.provide(ServerConfig.layer(config)),
        Layer.provide(Layer.succeed(References.MinimumLogLevel, minimumLogLevel)),
      ),
    ),
  );
});

const projectAddCommand = Command.make("add", {
  ...projectLocationFlags,
  workspaceRoot: Argument.String("path").pipe(
    Argument.withDescription("Workspace root to add as a project."),
  ),
  title: Flag.String("title").pipe(Flag.withDescription("Optional project title."), Flag.optional),
}).pipe(
  Command.withDescription("Add a project."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectAddMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: ProjectSnapshot;
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
      }) {
        const workspaceRoot = yield* normalizeWorkspaceRootForProjectCommand(flags.workspaceRoot);
        const existingProject = snapshot.projects.find(
          (project) => project.deletedAt === null && project.workspaceRoot === workspaceRoot,
        );
        if (existingProject) {
          return yield* new ProjectAlreadyExistsError({
            operation: "addProject",
            projectId: existingProject.id,
            workspaceRoot,
          });
        }

        const title = yield* resolveProjectTitle(workspaceRoot, Option.getOrUndefined(flags.title));
        const projectId = ProjectId.make(yield* projectCommandUuid);
        yield* dispatch({
          type: "project.create",
          commandId: CommandId.make(yield* projectCommandUuid),
          projectId,
          title,
          workspaceRoot,
        });
        return `Added project ${projectId} (${title}) at ${workspaceRoot}.`;
      }),
    ),
  ),
);

const projectRemoveCommand = Command.make("remove", {
  ...projectLocationFlags,
  project: Argument.String("project").pipe(
    Argument.withDescription("Project id or workspace root to remove."),
  ),
  force: Flag.Boolean("force").pipe(
    Flag.withDescription("Delete the project and all of its threads."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Remove a project."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectRemoveMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: ProjectSnapshot;
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
      }) {
        const project = yield* findActiveProjectTarget({
          snapshot,
          identifier: flags.project,
        });
        yield* dispatch({
          type: "project.delete",
          commandId: CommandId.make(yield* projectCommandUuid),
          projectId: project.id,
          force: flags.force,
        });
        return `Removed project ${project.id} (${project.title}).`;
      }),
    ),
  ),
);

const projectRenameCommand = Command.make("rename", {
  ...projectLocationFlags,
  project: Argument.String("project").pipe(
    Argument.withDescription("Project id or workspace root to rename."),
  ),
  title: Argument.String("title").pipe(Argument.withDescription("New project title.")),
}).pipe(
  Command.withDescription("Rename a project."),
  Command.withHandler((flags) =>
    runProjectMutation(
      flags,
      Effect.fn("projectRenameMutation")(function* ({
        snapshot,
        dispatch,
      }: {
        readonly snapshot: ProjectSnapshot;
        readonly dispatch: (
          command: ProjectCliDispatchCommand,
        ) => Effect.Effect<void, Error, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>;
      }) {
        const project = yield* findActiveProjectTarget({
          snapshot,
          identifier: flags.project,
        });
        const nextTitle = yield* resolveProjectTitle(project.workspaceRoot, flags.title);
        if (nextTitle === project.title) {
          return `Project ${project.id} is already named ${nextTitle}.`;
        }

        yield* dispatch({
          type: "project.update",
          commandId: CommandId.make(yield* projectCommandUuid),
          projectId: project.id,
          title: nextTitle,
        });
        return `Renamed project ${project.id} to ${nextTitle}.`;
      }),
    ),
  ),
);

const projectListCommand = Command.make("list", projectLocationFlags).pipe(
  Command.withDescription("List projects as tab-separated id, title, and workspace root."),
  Command.withHandler((flags) =>
    runProjectMutation(flags, ({ snapshot }) =>
      Effect.succeed(
        snapshot.projects
          .filter((project) => project.deletedAt === null)
          .map(
            (project) =>
              `${project.id}\t${project.title}\t${project.workspaceRoot}${
                project.archivedAt ? "\tarchived" : ""
              }`,
          )
          .join("\n") || "No projects.",
      ),
    ),
  ),
);

const decodeProjectManifest = Schema.decodeUnknownEffect(ProjectManifest);

const readProjectManifest = Effect.fn("readProjectManifest")(function* (manifestPath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const text = yield* fileSystem
    .readFileString(manifestPath)
    .pipe(
      Effect.mapError(
        (cause) =>
          new ProjectManifestReadError({ operation: "readProjectManifest", manifestPath, cause }),
      ),
    );
  const invalid = (detail: string, cause: unknown) =>
    new ProjectManifestInvalidError({
      operation: "decodeProjectManifest",
      manifestPath,
      detail,
      cause,
    });
  const parsed = yield* Effect.try({
    try: () => parseYaml(text) as unknown,
    catch: (cause) => invalid(cause instanceof Error ? cause.message : "not YAML or JSON", cause),
  });
  return yield* decodeProjectManifest(parsed).pipe(
    Effect.mapError((cause) => invalid(cause.message, cause)),
  );
});

const resolveDesiredProjects = Effect.fn("resolveDesiredProjects")(function* (
  manifestPath: string,
  manifest: ProjectManifest,
) {
  const path = yield* Path.Path;
  const manifestDir = path.dirname(path.resolve(manifestPath));
  const desired: Array<DesiredProject> = [];
  for (const entry of manifest.projects) {
    // Relative entries are relative to the manifest, so one checked-in file works from any cwd.
    const rawRoot =
      path.isAbsolute(entry.path) || entry.path.startsWith("~")
        ? entry.path
        : path.join(manifestDir, entry.path);
    const workspaceRoot = yield* normalizeWorkspaceRootForProjectCommand(rawRoot);
    if (desired.some((existing) => existing.workspaceRoot === workspaceRoot)) {
      return yield* new ProjectManifestDuplicatePathError({
        operation: "decodeProjectManifest",
        workspaceRoot,
      });
    }
    desired.push({
      workspaceRoot,
      title: entry.title,
      defaultTitle: yield* resolveProjectTitle(workspaceRoot),
    });
  }
  return desired;
});

const projectApplyMutation = Effect.fn("projectApplyMutation")(function* (
  action: ProjectApplyAction,
  force: boolean,
) {
  const commandId = CommandId.make(yield* projectCommandUuid);
  switch (action.kind) {
    case "add":
      return {
        type: "project.create",
        commandId,
        projectId: ProjectId.make(yield* projectCommandUuid),
        title: action.title,
        workspaceRoot: action.workspaceRoot,
      } satisfies ProjectCliDispatchCommand;
    case "rename":
      return {
        type: "project.update",
        commandId,
        projectId: action.project.id,
        title: action.title,
      } satisfies ProjectCliDispatchCommand;
    case "remove":
      return {
        type: "project.delete",
        commandId,
        projectId: action.project.id,
        force,
      } satisfies ProjectCliDispatchCommand;
  }
});

const projectApplyCommand = Command.make("apply", {
  ...projectLocationFlags,
  manifest: Argument.String("manifest").pipe(
    Argument.withDescription(
      "YAML or JSON file listing the projects this environment should have.",
    ),
  ),
  prune: Flag.Boolean("prune").pipe(
    Flag.withDescription("Remove projects the manifest does not list."),
    Flag.withDefault(false),
  ),
  force: Flag.Boolean("force").pipe(
    Flag.withDescription(
      "With --prune, also remove projects that have threads, and their threads.",
    ),
    Flag.withDefault(false),
  ),
  dryRun: Flag.Boolean("dry-run").pipe(
    Flag.withDescription("Print the changes without making them."),
    Flag.withDefault(false),
  ),
}).pipe(
  Command.withDescription("Make this environment's projects match a manifest."),
  Command.withHandler((flags) =>
    Effect.gen(function* () {
      // Validate before touching the server so a bad manifest changes nothing.
      const manifest = yield* readProjectManifest(flags.manifest);
      return yield* runProjectMutation(
        flags,
        Effect.fn("projectApply")(function* ({ snapshot, dispatch }) {
          const desired = yield* resolveDesiredProjects(flags.manifest, manifest);
          const actions = planProjectApply({
            projects: snapshot.projects,
            desired,
            prune: flags.prune,
          });
          if (actions.length === 0) {
            return "Projects match the manifest.";
          }
          const lines: Array<string> = [];
          for (const action of actions) {
            if (!flags.dryRun) {
              yield* dispatch(yield* projectApplyMutation(action, flags.force));
            }
            lines.push(describeProjectApplyAction(action));
          }
          lines.push(
            `${flags.dryRun ? "Would apply" : "Applied"} ${actions.length} change${
              actions.length === 1 ? "" : "s"
            }.`,
          );
          return lines.join("\n");
        }),
      );
    }),
  ),
);

export const projectCommand = Command.make("project").pipe(
  Command.withDescription("Manage projects."),
  Command.withSubcommands([
    projectAddCommand,
    projectRemoveCommand,
    projectRenameCommand,
    projectListCommand,
    projectApplyCommand,
  ]),
);
