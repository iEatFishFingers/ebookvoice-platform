"""conftest.py — makes the project root importable during pytest runs."""
import sys
import os

sys.path.insert(0, os.path.dirname(__file__))
