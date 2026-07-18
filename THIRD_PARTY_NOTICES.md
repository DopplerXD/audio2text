# Third-Party Notices

本文件记录本项目直接使用的第三方 AI 模型与模型运行时，不是 Python 间接依赖的完整许可证清单，也不构成本项目自身代码的许可证。

许可证信息核对日期：2026-07-18。

## 本地语音识别模型

项目通过 FunASR 的模型别名在首次使用时下载以下模型；模型权重没有包含在本仓库中。当前本地环境安装的 FunASR 1.3.16 将这些别名解析为下列 ModelScope 模型，模型卡均标注为 Apache License 2.0：

| 项目配置名 | 用途 | 官方模型 | 许可证 |
| --- | --- | --- | --- |
| `paraformer-zh` | 中文语音识别与时间戳 | [iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch](https://modelscope.cn/models/iic/speech_seaco_paraformer_large_asr_nat-zh-cn-16k-common-vocab8404-pytorch) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| `fsmn-vad` | 语音活动检测与长音频切分 | [iic/speech_fsmn_vad_zh-cn-16k-common-pytorch](https://modelscope.cn/models/iic/speech_fsmn_vad_zh-cn-16k-common-pytorch) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |
| `ct-punc` | 中英文标点恢复 | [iic/punc_ct-transformer_cn-en-common-vocab471067-large](https://modelscope.cn/models/iic/punc_ct-transformer_cn-en-common-vocab471067-large) | [Apache-2.0](https://www.apache.org/licenses/LICENSE-2.0.txt) |

这些名称是 FunASR 的未固定版本别名。升级 FunASR、切换模型仓库或发布包含模型权重的制品前，应重新确认实际解析到的模型、版本和模型卡许可证。

如果将上述模型权重或修改后的权重随安装包、镜像或其他制品一起再分发，应随制品提供 Apache-2.0 许可证文本，保留适用的版权、专利、商标和归属声明，并显著说明对文件所作的修改。具体义务以对应模型版本附带的许可证和 NOTICE 文件为准。

## 模型运行时

- [FunASR](https://github.com/modelscope/FunASR) 工具包：MIT License。FunASR 的代码许可证与各预训练模型的权重许可证彼此独立。
- [ModelScope](https://github.com/modelscope/modelscope) 下载/模型管理组件：Apache License 2.0。

安装产生的其他 Python 依赖仍分别受其上游许可证约束；分发完整应用或容器时，应根据锁定的实际依赖版本生成完整的软件物料清单和依赖许可证清单。

## 外部托管模型服务

项目可通过 `https://api.deepseek.com` 调用 `deepseek-v4-flash`。它是运行时访问的外部托管服务，模型权重和服务端代码不包含在本仓库及其发布物中，因此不列为本项目分发的开源模型。使用者仍须遵守 [DeepSeek API 文档](https://api-docs.deepseek.com/)及其链接的[开放平台服务条款](https://cdn.deepseek.com/policies/en-US/deepseek-open-platform-terms-of-service.html)。

## 本项目代码的许可证状态

第三方组件采用 MIT 或 Apache-2.0，不会自动使本项目代码获得相同许可证。本仓库目前没有根目录 `LICENSE` 文件；在项目作者明确选择许可证前，`THIRD_PARTY_NOTICES.md` 只用于第三方归属说明，不授予复制、修改或再分发本项目代码的权利。
