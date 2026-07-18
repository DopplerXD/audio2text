# 本地音频转文字

一个本地运行的音频/视频转写与智能内容处理工具。当前版本为 v1.4：FunASR + Paraformer-zh 在本地完成中文识别，DeepSeek V4 Flash 可继续执行智能整理、版本对比、语境检查和场景化分析。

## 功能

- 本地 Web 页面，默认运行在 `http://127.0.0.1:7860`
- 支持上传常见音频/视频格式：MP3、M4A、WAV、AAC、FLAC、MP4、MOV、MKV
- 使用 FFmpeg 转换为 16kHz 单声道 WAV
- 使用 FunASR `paraformer-zh + fsmn-vad + ct-punc` 完成中文识别、VAD 分段和标点处理
- 使用 SQLite 保存历史记录，重启后仍可查看
- 支持编辑完整文本和字幕分段
- 支持导出 TXT、Markdown、PDF、SRT、VTT、JSON
- 支持一键导出全部格式并打包 ZIP
- 智能整理可组合口水词去除、书面化改写、计算机术语修正和 Qn/An/Rn 问答分离
- 默认仅启用“口水词去除 + 另存为新文件”，不会改动原始识别结果
- 可同步处理字幕分段并生成 SRT/VTT，可额外保存 Markdown
- 人工检查会标记不符合语境的非常用词，编辑标记片段后高亮自动解除
- STEP 2 可在左右两侧选择最初版、整理版本和检查版本，查看中文/英文术语级 Diff；左侧版本同时作为送检来源
- 后端开发面试分析提供总体评价、维度评分、逐题优缺点和改进思路；未识别到回答时改为展示题目考察方向且不评分

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

复制环境配置并填写 DeepSeek API Key：

```bash
cp .env.example .env
```

编辑 `.env`：

```dotenv
DEEPSEEK_API_KEY=你的_API_Key
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-v4-flash
DEEPSEEK_TIMEOUT_SECONDS=180
```

`.env` 已加入 `.gitignore`，真实密钥不会进入版本控制。修改 `.env` 后需要重启服务。

如果不使用虚拟环境，也可以直接安装到当前 Python 环境：

```bash
python3 -m pip install -r requirements.txt
```

首次识别时，FunASR 会下载模型文件，耗时取决于网络和机器性能。

> 隐私提示：音频识别在本地完成；只有在点击智能整理、人工检查或智能分析时，相应文字内容才会发送至配置的 DeepSeek API。请确认内容符合你的数据处理要求。

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
├── ai_service.py          # DeepSeek 客户端、Prompt 与三阶段处理逻辑
├── audio_utils.py         # FFmpeg 检查、上传保存和转码
├── config.py              # 路径、模型和应用配置
├── exporters.py           # TXT / MD / PDF / SRT / VTT / JSON / ZIP 导出
├── models.py              # 数据结构
├── storage.py             # SQLite 持久化
├── transcriber.py         # FunASR 识别和结果适配
├── versioning.py          # 文本版本解析与中英文 Diff
├── static/
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── requirements.txt
├── .env.example           # DeepSeek 环境配置模板
├── tests/                 # AI、持久化与 API 自动化测试
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
- `GET /api/transcriptions/{id}/versions`
- `POST /api/transcriptions/{id}/versions/diff`
- `PATCH /api/transcriptions/{id}`
- `DELETE /api/transcriptions/{id}`
- `POST /api/transcriptions/{id}/exports`
- `POST /api/transcriptions/{id}/exports/all`
- `POST /api/transcriptions/{id}/ai/organize`
- `POST /api/transcriptions/{id}/ai/review`
- `PATCH /api/transcriptions/{id}/ai/reviews/{run_id}`
- `POST /api/transcriptions/{id}/ai/analyze`
- `GET /api/files/{file_id}`

## 开发检查

```bash
python3 -m py_compile app.py api.py ai_service.py versioning.py models.py config.py audio_utils.py transcriber.py storage.py exporters.py
```

运行自动化测试：

```bash
python3 -m unittest discover -s tests -v
```

依赖导入检查：

```bash
python3 -c "from funasr import AutoModel; print('funasr ok')"
```
