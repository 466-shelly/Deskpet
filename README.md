# Deskpet

基于 Electron 的 Windows 桌面宠物应用：透明无边框窗口、拖拽防走丢、系统托盘、设置面板与本地配置热重载。

## 功能概览

- 透明置顶桌宠窗口，支持 webm / mp4 / mov / gif / webp
- 鼠标拖拽移动，释放时超出屏幕自动平滑吸附回边缘
- 悬停显示互动按钮，点击随机气泡回应 + 跳跃/震动动画
- 系统托盘：设置面板、显示/隐藏、退出
- 设置面板：上传素材、自定义文案与尺寸，保存后桌宠实时更新
- 5 分钟无操作自动暂停视频，鼠标进入或交互时恢复播放

## 环境要求

- [Node.js](https://nodejs.org/) 18 或更高版本
- Windows 10 / 11

## 安装与运行

```bash
# 进入项目目录
cd Deskpet

# 安装依赖
npm install

# 启动应用
npm start
```

首次启动会显示内置 SVG 占位形象，并提示 **右键桌宠** 打开设置面板。

## 使用说明

| 操作 | 说明 |
|------|------|
| 左键拖拽 | 移动桌宠位置 |
| 悬停 | 显示「互动」按钮 |
| 点击互动按钮 | 随机回应 + 动画 |
| 右键 | 打开设置面板 |
| 托盘图标 | 左键显示/隐藏；右键菜单 |

### 设置面板

1. **媒体素材**：选择本地文件后会复制到 `%APPDATA%/deskpet/media/`，避免原文件被删导致失效。
2. **尺寸**：滑块调整宽高，保存后立即生效。
3. **互动按钮 / 回应语料 / 闲置提示语**：按行编辑文案数组。
4. 点击 **保存并应用到桌宠** 写入 `config.json` 并通过 IPC 热更新桌宠窗口。

配置文件路径示例：

```
C:\Users\<用户名>\AppData\Roaming\deskpet\config.json
```

## 项目结构

```
Deskpet/
├── main.js          # 主进程：窗口、托盘、IPC、文件读写
├── pet.html         # 桌宠渲染页（单文件 HTML/CSS/JS）
├── panel.html       # 设置面板
├── package.json
├── assets/
│   └── default.svg  # 默认占位素材
└── README.md
```

## 打包建议

推荐使用 [electron-builder](https://www.electron.build/) 生成 Windows 安装包。

### 1. 安装打包工具

```bash
npm install --save-dev electron-builder
```

### 2. 在 `package.json` 中补充字段

```json
{
  "build": {
    "appId": "com.deskpet.app",
    "productName": "Deskpet",
    "directories": {
      "output": "dist"
    },
    "files": [
      "main.js",
      "pet.html",
      "panel.html",
      "assets/**/*"
    ],
    "win": {
      "target": ["nsis"],
      "icon": "assets/tray-icon.png"
    },
    "nsis": {
      "oneClick": false,
      "allowToChangeInstallationDirectory": true
    }
  },
  "scripts": {
    "start": "electron .",
    "dist": "electron-builder --win"
  }
}
```

### 3. 执行打包

```bash
npm run dist
```

产物位于 `dist/` 目录。可按需添加 `assets/tray-icon.png`（建议 256×256）作为应用与托盘图标。

## 开发与注意事项

- 视频标签需 `autoplay loop muted` 才能在 Electron 中自动循环播放。
- 桌宠窗口设置了 `skipTaskbar: true`，请通过托盘或右键面板管理应用。
- 若透明窗口在部分系统上显示异常，可检查显卡驱动或关闭「硬件加速」进行对比测试（在 `main.js` 的 `app.whenReady()` 前添加 `app.disableHardwareAcceleration()` 仅作排查用）。

## License

MIT
