import { Fragment, useEffect, useMemo, useState } from "react";
import type { ProjectMemoryWorkspaceSummary } from "@zcode/services";
import {
  TID_SETTINGS_MEMORY_COUNT,
  TID_SETTINGS_MEMORY_FILE,
  TID_SETTINGS_MEMORY_FILE_EDITOR_ACTIONS,
  TID_SETTINGS_MEMORY_FILE_ICON,
  TID_SETTINGS_MEMORY_FILE_NAME,
  TID_SETTINGS_MEMORY_FILE_UPDATED_AT,
  TID_SETTINGS_MEMORY_REFRESH,
  TID_SETTINGS_MEMORY_SCOPE_ICON,
  TID_SETTINGS_MEMORY_SCOPE_TRIGGER,
  TID_SETTINGS_MEMORY_SEARCH_CLEAR,
  TID_SETTINGS_MEMORY_SEARCH_INPUT,
  TID_SETTINGS_MEMORY_WORKSPACE,
  testId,
} from "@zcode/shared";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { FileDisplayIcon, resolveFileDisplayDescriptor } from "@/lib/fileDisplay.js";
import { PluginScopeMenu } from "@/settings/PluginScopeMenu.js";
import { PluginSearchEmptyState } from "@/settings/PluginInstallEmptyState.js";
import { SettingsSearchInput } from "@/settings/SettingsSearchInput.js";
import { SettingsResourceHeaderActions } from "@/settings/SettingsResourceHeaderActions.js";
import { formatMemoryUpdatedAt } from "@/settings/memoryUpdatedAt.js";
import { WorkspaceEditorButtonGroup } from "@/WorkspaceEditorButtonGroup.js";

export type MemoryViewerLoadingState = "idle" | "loading" | "ready" | "error";

export function MemorySettingsViewer({
  catalogError,
  catalogState,
  selectedWorkspace,
  workspaces,
  onRefresh,
  onReadFile,
  onScopeKeyChange,
}: {
  catalogError: string | null;
  catalogState: MemoryViewerLoadingState;
  selectedWorkspace: ProjectMemoryWorkspaceSummary | undefined;
  workspaces: ProjectMemoryWorkspaceSummary[];
  onRefresh: () => Promise<void>;
  onReadFile: (params: {
    workspaceId: string;
    fileName: string;
  }) => Promise<{ content: string; updatedAt: number }>;
  onScopeKeyChange: (workspaceId: string) => void;
}) {
  const { intl, locale } = useZCodeIntl();
  const [searchQuery, setSearchQuery] = useState("");
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const interval = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(interval);
  }, []);
  // 内容预览弹窗：文件行可点击，读取经 onReadFile（/ws → server 本机文件）。
  const [preview, setPreview] = useState<{
    fileName: string;
    state: "loading" | "ready" | "error";
    content?: string;
  } | null>(null);

  const handleOpenFile = async (workspaceId: string, fileName: string) => {
    setPreview({ fileName, state: "loading" });
    try {
      const result = await onReadFile({ workspaceId, fileName });
      // 弹窗可能在等待期间被关掉；只有仍是同一文件时才写入内容。
      setPreview((current) =>
        current && current.fileName === fileName
          ? { fileName, state: "ready", content: result.content }
          : current,
      );
    } catch {
      setPreview((current) =>
        current && current.fileName === fileName ? { fileName, state: "error" } : current,
      );
    }
  };
  const formatMemoryCount = (count: number) =>
    intl.formatMessage(
      {
        id: `settings.memory.viewer.memoryCount.${count === 1 ? "one" : "other"}`,
      },
      { count },
    );
  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase();
  const visibleFiles = useMemo(
    () =>
      selectedWorkspace?.files.filter((file) =>
        file.name.toLocaleLowerCase().includes(normalizedSearchQuery),
      ) ?? [],
    [normalizedSearchQuery, selectedWorkspace],
  );

  if (catalogError) {
    return (
      <Alert>
        <AlertDescription>{catalogError}</AlertDescription>
      </Alert>
    );
  }

  if (catalogState === "loading" && workspaces.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.memory.viewer.loading" })}
      </div>
    );
  }

  if (!selectedWorkspace) {
    return (
      <div className="rounded-xl border border-dashed border-border bg-transparent px-4 py-8 text-center text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.memory.viewer.empty" })}
      </div>
    );
  }

  return (
    <section className="space-y-4">
      <div className="flex min-w-0 flex-wrap items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <PluginScopeMenu
            includeUser={false}
            selectedScopeKey={selectedWorkspace.id}
            workspaceOptions={workspaces.map((workspace) => ({
              key: workspace.id,
              label: workspace.label,
            }))}
            onScopeKeyChange={onScopeKeyChange}
            triggerIconTestId={TID_SETTINGS_MEMORY_SCOPE_ICON}
            triggerTestId={TID_SETTINGS_MEMORY_SCOPE_TRIGGER}
            workspaceOptionTestIdPrefix={TID_SETTINGS_MEMORY_WORKSPACE}
          />
          <div className="h-4 w-px bg-border" aria-hidden="true" />
          <span
            data-testid={TID_SETTINGS_MEMORY_COUNT}
            className="shrink-0 text-ui-sm text-foreground-subtle"
          >
            {formatMemoryCount(selectedWorkspace.files.length)}
          </span>
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center justify-end gap-2">
          <SettingsSearchInput
            containerClassName="w-full sm:w-64"
            clearLabel={intl.formatMessage({ id: "settings.search.clear" })}
            clearTestId={TID_SETTINGS_MEMORY_SEARCH_CLEAR}
            data-testid={TID_SETTINGS_MEMORY_SEARCH_INPUT}
            value={searchQuery}
            onClear={() => setSearchQuery("")}
            onChange={(event) => setSearchQuery(event.target.value)}
            placeholder={intl.formatMessage({
              id: "settings.memory.viewer.searchPlaceholder",
            })}
          />
        </div>
      </div>

      {normalizedSearchQuery && visibleFiles.length === 0 ? (
        <PluginSearchEmptyState
          label={intl.formatMessage({
            id: "settings.memory.viewer.searchEmpty",
          })}
        />
      ) : (
        <>
          <div className="flex min-h-7 flex-wrap items-center justify-between gap-3">
            <h3 className="text-ui-base font-medium text-foreground">
              {intl.formatMessage({ id: "settings.memory.viewer.files" })}
            </h3>
            <SettingsResourceHeaderActions
              onRefresh={() => void onRefresh()}
              refreshing={catalogState === "loading"}
              refreshTestId={TID_SETTINGS_MEMORY_REFRESH}
              refreshLabel={intl.formatMessage({
                id: "settings.memory.viewer.refresh",
              })}
            />
          </div>
          <div className="overflow-hidden rounded-xl bg-surface">
            {visibleFiles.map((file, index) => (
              <Fragment key={file.name}>
                {index > 0 ? <div className="h-px bg-border/50" aria-hidden="true" /> : null}
                <div className="flex min-w-0 items-center hover:bg-hover">
                  {/* 文件行可点击：应用内直接预览内容。web/手机没有外部编辑器，
                      原先只能靠 WorkspaceEditorButtonGroup 桌面编辑器打开。 */}
                  <div
                    data-testid={testId(TID_SETTINGS_MEMORY_FILE, file.name)}
                    role="button"
                    tabIndex={0}
                    onClick={() => void handleOpenFile(selectedWorkspace.id, file.name)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        void handleOpenFile(selectedWorkspace.id, file.name);
                      }
                    }}
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-4 py-3 text-left"
                  >
                    <span
                      data-testid={testId(TID_SETTINGS_MEMORY_FILE_ICON, file.name)}
                      className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-background"
                    >
                      <FileDisplayIcon
                        src={resolveFileDisplayDescriptor(file.path).fileIconSrc}
                        size={16}
                        className="size-4 shrink-0"
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span
                        data-testid={testId(TID_SETTINGS_MEMORY_FILE_NAME, file.name)}
                        className="block truncate text-ui-base font-medium text-foreground"
                      >
                        {file.name}
                      </span>
                      <span
                        data-testid={testId(TID_SETTINGS_MEMORY_FILE_UPDATED_AT, file.name)}
                        className="mt-0.5 block truncate text-ui-sm text-foreground-subtle"
                      >
                        {formatMemoryUpdatedAt({
                          formatMessage: intl.formatMessage,
                          locale,
                          now,
                          updatedAt: file.updatedAt,
                        })}
                      </span>
                    </span>
                  </div>
                  <span
                    data-testid={testId(TID_SETTINGS_MEMORY_FILE_EDITOR_ACTIONS, file.name)}
                    className="mr-3 shrink-0"
                  >
                    <WorkspaceEditorButtonGroup workspaceAbsPath={file.path} />
                  </span>
                </div>
              </Fragment>
            ))}
          </div>
        </>
      )}

      <Dialog
        open={preview !== null}
        onOpenChange={(open) => {
          if (!open) setPreview(null);
        }}
      >
        <DialogContent className="flex max-h-[80vh] w-[min(680px,calc(100vw-2rem))] flex-col gap-3">
          {/* 标题必须 shrink-0：flex 容器总高超过 max-h 收缩分配时，truncate（overflow:hidden）
              会把标题的自动最小尺寸清零，内容越长标题被压得越扁直至不可见（实测 26px→3.4px）。
              shrink-0 后收缩全部落在 min-h-0 的内容区上。 */}
          <DialogTitle className="shrink-0 truncate pr-8 text-ui-lg font-medium text-foreground">
            {preview?.fileName ?? ""}
          </DialogTitle>
          {preview?.state === "loading" ? (
            <div className="px-1 py-8 text-center text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.memory.viewer.loading" })}
            </div>
          ) : preview?.state === "error" ? (
            <div className="px-1 py-8 text-center text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.memory.viewer.preview.failed" })}
              <button
                type="button"
                className="ml-2 text-ui-base text-foreground underline underline-offset-2"
                onClick={() => {
                  if (selectedWorkspace) {
                    void handleOpenFile(selectedWorkspace.id, preview.fileName);
                  }
                }}
              >
                {intl.formatMessage({ id: "settings.memory.viewer.preview.retry" })}
              </button>
            </div>
          ) : preview?.state === "ready" ? (
            <pre className="min-h-0 flex-1 overflow-auto rounded-lg border border-border bg-background p-3 text-ui-sm whitespace-pre-wrap break-words text-foreground">
              {preview.content}
            </pre>
          ) : null}
        </DialogContent>
      </Dialog>
    </section>
  );
}
