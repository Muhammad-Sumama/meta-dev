# GPU inference server for OpenSAM Studio (SAM 2 + optional Grounding DINO).
#   docker build -t opensam-inference inference/
#   docker run --gpus all -p 8008:8008 -e INFERENCE_API_KEY=change-me opensam-inference
FROM pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg git && rm -rf /var/lib/apt/lists/*
WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app

ENV SAM2_MODEL_ID=facebook/sam2.1-hiera-large \
    GROUNDING_MODEL=IDEA-Research/grounding-dino-tiny \
    SAM2_MAX_SESSIONS=2
EXPOSE 8008
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8008"]
