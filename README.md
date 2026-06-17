# 本地音频转文字

一个本地运行的音频/视频转写工具。当前版本为 v1.2，识别引擎使用 FunASR + Paraformer-zh 中文离线模型，支持上传单个音频或视频文件、查看和编辑转写结果、保存历史记录，并导出 TXT、Markdown、PDF、SRT、VTT、JSON 和 ZIP。

## 功能

- 本地 Web 页面，默认运行在 `http://127.0.0.1:7860`
- 支持上传常见音频/视频格式：MP3、M4A、WAV、AAC、FLAC、MP4、MOV、MKV
- 使用 FFmpeg 转换为 16kHz 单声道 WAV
- 使用 FunASR `paraformer-zh + fsmn-vad + ct-punc` 完成中文识别、VAD 分段和标点处理
- 使用 SQLite 保存历史记录，重启后仍可查看
- 支持编辑完整文本和字幕分段
- 支持导出 TXT、Markdown、PDF、SRT、VTT、JSON
- 支持一键导出全部格式并打包 ZIP

## 环境要求

- Python 3.10 或更高版本
- FFmpeg
- macOS / Linux / Windows 均可运行，当前默认设备为 CPU

安装 FFmpeg：

```bash
brew install ffmpeg
```

## 安装

```bash
cd /Users/doppler/Documents/develop/audio2text
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

如果不使用虚拟环境，也可以直接安装到当前 Python 环境：

```bash
python3 -m pip install -r requirements.txt
```

首次识别时，FunASR 会下载模型文件，耗时取决于网络和机器性能。

## 启动与停止

启动：

```bash
cd /Users/doppler/Documents/develop/audio2text
python3 app.py
```

浏览器打开：

```text
http://127.0.0.1:7860
```

停止：

```bash
Ctrl+C
```

如果服务在后台运行，可以按端口停止：

```bash
lsof -tiTCP:7860 -sTCP:LISTEN | xargs kill
```

## 设备配置

默认使用 CPU：

```bash
python3 app.py
```

可以通过环境变量覆盖 FunASR 设备：

```bash
FUNASR_DEVICE=cpu python3 app.py
```

## 项目结构

```text
audio2text/
├── app.py                 # FastAPI 应用入口
├── api.py                 # API 路由
├── audio_utils.py         # FFmpeg 检查、上传保存和转码
├── config.py              # 路径、模型和应用配置
├── exporters.py           # TXT / MD / PDF / SRT / VTT / JSON / ZIP 导出
├── models.py              # 数据结构
├── storage.py             # SQLite 持久化
├── transcriber.py         # FunASR 识别和结果适配
├── static/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── requirements.txt
└── README.md
```

运行时目录会自动创建，并已加入 `.gitignore`：

```text
data/
uploads/
temp/
outputs/
test_data/
```

## API

主要接口：

- `GET /api/health`
- `POST /api/transcriptions`
- `GET /api/transcriptions`
- `GET /api/transcriptions/{id}`
- `PATCH /api/transcriptions/{id}`
- `DELETE /api/transcriptions/{id}`
- `POST /api/transcriptions/{id}/exports`
- `POST /api/transcriptions/{id}/exports/all`
- `GET /api/files/{file_id}`

## 开发检查

```bash
python3 -m py_compile app.py api.py models.py config.py audio_utils.py transcriber.py storage.py exporters.py
```

依赖导入检查：

```bash
python3 -c "from funasr import AutoModel; print('funasr ok')"
```
