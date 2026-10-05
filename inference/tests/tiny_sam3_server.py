"""The real HTTP app serving Sam3Backend with tiny random SAM 3 models
(web app ↔ SAM 3 server integration checks without weights or a GPU):

    uvicorn tests.tiny_sam3_server:app --port 8008
"""

import os

os.environ.setdefault("OPENSAM_INFERENCE_NO_AUTOLOAD", "1")

from app.backend import Sam3Backend  # noqa: E402
from app.main import create_app  # noqa: E402

from . import tiny_sam3  # noqa: E402

backend = Sam3Backend(loader=tiny_sam3.loader)
backend._det_threshold = float(os.environ.get("SAM3_DETECTION_THRESHOLD", "0"))  # random weights: keep detections
app = create_app(backend)
