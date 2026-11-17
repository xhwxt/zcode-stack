# DirectoryBrowser 新建文件夹

## 背景
添加项目 → 浏览文件夹（packages/ui/src/DirectoryBrowser.tsx）只有
选择能力，无法在浏览位置创建新目录。

## 规则
1. 能力归属：创建目录是文件系统能力，收口到 IFileService.createDirectory
   （单方法，recursive: false 语义——父目录必须存在，避免 UI 拼写错误
   在错误层级批量建目录）。服务端用 node:fs/promises mkdir 实现；
   web 端经既有 file channel 自动获得（ProxyChannel 自动分派，
   server entry-http 已注册 IFileService）。
2. UI：DirectoryBrowser 工具行加"新建文件夹"按钮 → 行内输入框 +
   确认/取消。成功后 navigateTo 刷新当前目录；失败（已存在/权限）
   展示 errorReadDir 同区域的错误行。
3. 状态所有者：isCreating + newDirectoryName 全部为 DirectoryBrowser
   组件局部 useState，不进全局 store；对话框关闭即丢弃。
4. 名称校验：非空、不含 / 与 \、不等于 . 或 ..。路径拼接由服务端
   join 完成，UI 不传完整路径，避免越权路径注入。
5. i18n：directoryBrowser.newFolder / newFolderName / create /
   errorCreate 新键，zh-CN 与 en-US 同步补齐。
6. 嵌入模式（embedded=true，SSHDialog 复用）同样获得该能力。

## 验收
- 390x844 与 1280x800 视口都能在当前目录创建子目录并立即看到。
- 已存在同名目录时显示错误且列表不刷新错乱。
- typecheck/lint 通过。
