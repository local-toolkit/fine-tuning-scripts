# Netflix Local Dual Subtitles

一个只在本机运行的 Chrome MV3 扩展：读取 Netflix 当前显示的字幕，通过 Ollama 调用本地模型翻译成简体中文，并把中文显示在原字幕上方。

## 针对这台 MacBook Air 的模型选择

当前机器是 Apple M1、16GB 内存。默认模型是 `translategemma:4b`：它是专门的翻译模型，Ollama 版本约 3.3GB，英语/日语/韩语到中文更适合字幕场景。服务默认通过 `keep_alive=10m` 保持短时热机，减少重复加载，同时避免长时间占用内存；可用环境变量 `NLLS_KEEP_ALIVE` 调整。

如果想要低延迟且更偏重字幕翻译，可以在扩展设置里选择 `kaelri/hy-mt2:1.8b`。它基于腾讯发布的 Hy-MT 2.0 1.8B 权重，并带有适配 Ollama 的提示模板；扩展也保留 `qwen3:1.7b` 作为更轻量的通用模型。两种模型都不会调用云端 API。

## 第一次使用

1. 确认 Ollama 已安装并启动。
2. 下载模型：

   ```bash
   ollama pull translategemma:4b
   ```

   如果想使用 HY-MT 字幕翻译模式：

   ```bash
   ollama run kaelri/hy-mt2:1.8b
   ```

   如果想使用更轻量模式：

   ```bash
   ollama pull qwen3:1.7b
   ```

3. 启动本地桥接服务：

   ```bash
   cd /Users/xujintao/Documents/workspace/fine-tuning-scripts/netflix-local-dual-subtitles
   PYTHONDONTWRITEBYTECODE=1 python3 server.py
   ```

   如果 Ollama 没有自动运行，另开一个终端执行 `ollama serve`。

4. 打开 Chrome 的 `chrome://extensions`，开启“开发者模式”，点击“加载已解压的扩展程序”，选择本目录。
5. 刷新 Netflix 播放页面，先在 Netflix 播放器中打开英语、日语或韩语字幕，再点击扩展图标检查连接。

> 注意：Chrome 不允许未打包扩展目录里出现 `__pycache__` 或 `.pyc` 文件。运行本地 Python 服务时请使用 `PYTHONDONTWRITEBYTECODE=1 python3 server.py`；不要在扩展目录里直接运行 `python -m py_compile`。

## 用插件按钮启动/停止模型

Chrome 扩展本身不能直接执行 `ollama serve`。项目提供了一个 Native Messaging 宿主，让扩展按钮可以启动和停止本地进程。首次需要注册一次宿主：

### macOS

1. 先在 `chrome://extensions` 加载本目录。
2. 复制该扩展显示的 32 位 ID。
3. 执行：

   ```bash
   cd /Users/xujintao/Documents/workspace/fine-tuning-scripts/netflix-local-dual-subtitles
   bash install_native_host.sh <扩展 ID>
   ```

4. 回到 `chrome://extensions`，点击该扩展的“重新加载”。
5. 打开插件，点击“启动本地模型”。

### Windows

前提条件：Python 3 已安装并加入 PATH（`python --version` 可确认）、Ollama 已安装并启动、目标模型已下载（参考[第一次使用](#第一次使用)）。

1. 在 `chrome://extensions` 确认本扩展已加载，记下 32 位扩展 ID。
2. 以**当前用户**身份打开 PowerShell（无需管理员权限），执行：

   ```powershell
   cd C:\path\to\netflix-local-dual-subtitles
   powershell -ExecutionPolicy Bypass -File .\install_native_host.ps1 <扩展 ID>
   ```

3. 回到 `chrome://extensions`，点击该扩展的“重新加载”。
4. 打开插件，点击“启动本地模型”。

注册信息保存在当前用户的注册表（HKCU）中，无需管理员权限。安装脚本会在 `HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.netflix.local_dual_subtitles` 下写入注册项，manifest 的 `path` 指向 `native_host.cmd`。

点击“启动本地模型”后，Native Messaging 宿主会依次启动 Ollama（如未运行）和 `server.py`。如果注册成功但启动失败（例如 Python 缺失、Ollama 未启动、模型未下载），插件会显示具体的错误信息；如果 Chrome 报错 `Specified native messaging host not found`，说明注册表或 manifest 文件有误——请对照下方的验证步骤检查。如果报错是 `Native host has exited`，说明 Chrome 能找到宿主 manifest 并成功启动，但 `native_host.cmd` 或它调用的 Python 进程异常退出了（常见原因：Python 未安装或不在 PATH 中、脚本路径错误）。

验证注册：

- 打开注册表编辑器（`regedit`），检查 `HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\com.netflix.local_dual_subtitles` 是否存在，`(默认)` 值是否指向 manifest JSON 文件。
- 检查 manifest 文件中 `path` 是否指向正确的 `native_host.cmd`，`allowed_origins` 是否包含 `chrome-extension://<你的扩展 ID>/`。

如果扩展 ID 发生变化，重新运行安装脚本即可。

## 字幕样式与位置

插件弹窗里的“字幕样式”和“字幕位置”设置会保存在本机：

- 字号、字体、粗细；
- 文字颜色、背景颜色、背景透明度；
- 水平和垂直位置；
- 点击“进入拖动模式”后，可以直接拖动播放器上的中文字幕；
- 点击“重置位置”恢复默认位置。

修改后点击“保存设置”。

启动按钮会按需启动 Ollama 和 `server.py`；“停止本地模型”会停止由插件启动的进程。如果 Ollama 原本已经在运行，插件不会强制关闭它，但会尝试让当前模型释放内存。关闭“启用中文翻译”开关、停用/重新加载插件时，Native Messaging 宿主会清理插件托管的服务和模型；关闭 Chrome 或最后一个 Netflix 标签页也会触发同样的清理。

## 设计边界

- 只读取 Netflix 当前页面已有的文字字幕，不处理音频，也不处理 DRM。
- Netflix 没有提供某种语言字幕时，第一版不会自动听音翻译；后续可以增加本地 Whisper 语音识别。
- Netflix 页面结构变化时，字幕选择器可能需要更新。
- 本地服务只监听 `127.0.0.1:8765`，不会暴露到局域网。
- 为避免多个 Netflix 标签页同时占满内存，本地模型同一时间只处理一个翻译请求；忙时插件会稍后自动重试。
- macOS 上 Native Messaging 宿主注册在 `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/`；Windows 上注册在 `HKEY_CURRENT_USER\Software\Google\Chrome\NativeMessagingHosts\`（参见 [Windows 注册步骤](#windows)）。扩展 ID 变化后需要重新运行安装脚本。
- 插件中的模型下拉框提供 TranslateGemma 4B、HY-MT2 1.8B、Qwen3 4B、Qwen3 1.7B 和 Qwen2.5 3B；Qwen3 会自动关闭 thinking 以降低字幕延迟。切换前请先用 Ollama 下载对应模型。已有的 `hy-mt1.5:1.8b` 设置会自动迁移到可用的 Hy-MT2 标签。
- 翻译结果会通过本机随附的 OpenCC 转换为简体中文；OpenCC 依赖已放在本扩展目录内，加载 Chrome 扩展时只需要选择本目录。
