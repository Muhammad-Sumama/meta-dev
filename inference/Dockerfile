# GPU inference server for OpenSAM Studio: SAM 3 (default) or SAM 2.
#   docker build -t opensam-inference inference/
#   docker run --gpus all -p 8008:8008 -e INFERENCE_API_KEY=change-me -e HF_TOKEN=hf_... opensam-inference
#   (SAM 2 instead: -e MODEL_FAMILY=sam2)
# SAM 3 weights are gated: accept the license at huggingface.co/facebook/sam3
# with the account whose HF_TOKEN you pass. Mount a volume at /root/.cache/huggingface
# so they're downloaded once (~3.5 GB).
FROM pytorch/pytorch:2.11.0-cuda12.8-cudnn9-runtime

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app

ENV MODEL_FAMILY=sam3 \
    SAM3_MODEL_ID=facebook/sam3 \
    SAM2_MODEL_ID=facebook/sam2.1-hiera-large \
    GROUNDING_MODEL=IDEA-Research/grounding-dino-tiny \
    SAM2_MAX_SESSIONS=2
EXPOSE 8008
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8008"]
