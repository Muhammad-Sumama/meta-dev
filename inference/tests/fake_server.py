"""Runs the real HTTP app with the fake backend (for cross-language contract checks):

    uvicorn tests.fake_server:app --port 8008
"""

import os

os.environ.setdefault("OPENSAM_INFERENCE_NO_AUTOLOAD", "1")

from app.main import create_app  # noqa: E402
from tests.test_api import FakeBackend  # noqa: E402

app = create_app(FakeBackend())
