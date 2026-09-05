#!/usr/bin/env python3
"""Local OAuth helper for gmail-lifecycle Worker.

Run this once on your machine to obtain a Gmail refresh token, then set it
as a Worker secret. The Worker uses the refresh token to get access tokens
at runtime — no local machine needed after this.

Usage:
    uv run scripts/get_refresh_token.py

Prerequisites:
    1. A Google Cloud project with Gmail API enabled.
    2. An OAuth 2.0 Client ID (type: "Desktop app").
    3. Download the client secret JSON and place it as credentials.json
       in this directory (or pass --credentials /path/to/file.json).

Required Gmail API scopes:
    https://www.googleapis.com/auth/gmail.readonly
    https://www.googleapis.com/auth/gmail.settings.basic
    https://www.googleapis.com/auth/gmail.modify
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

SCOPES = [
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/gmail.settings.basic",
    "https://www.googleapis.com/auth/gmail.modify",
]


def main() -> None:
    parser = argparse.ArgumentParser(description="Get Gmail OAuth refresh token for Worker.")
    parser.add_argument(
        "--credentials",
        default="credentials.json",
        help="Path to OAuth client secrets JSON (default: credentials.json)",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=0,
        help="Local server port for OAuth callback (default: random)",
    )
    args = parser.parse_args()

    creds_path = Path(args.credentials)
    if not creds_path.exists():
        raise FileNotFoundError(
            f"Credentials file not found: {creds_path}\n"
            "Download it from Google Cloud Console > APIs & Services > Credentials > "
            "OAuth 2.0 Client ID (Desktop app) > Download JSON."
        )

    from google_auth_oauthlib.flow import InstalledAppFlow

    flow = InstalledAppFlow.from_client_secrets_file(str(creds_path), SCOPES)
    creds = flow.run_local_server(port=args.port)

    print("\n=== Gmail OAuth Token ===\n")
    print(f"Access token:  {creds.token[:20]}... (expires in ~1h)")
    print(f"Refresh token: {creds.refresh_token}")
    print(f"Client ID:     {creds.client_id}")
    print(f"Client secret: {creds.client_secret}")
    print("\nSet these as Worker secrets:")
    print("  cd bots/gmail-lifecycle")
    print("  echo 'GMAIL_CLIENT_ID=<your-client-id>' >> .dev.vars")
    print("  echo 'GMAIL_CLIENT_SECRET=<your-client-secret>' >> .dev.vars")
    print("  echo 'GMAIL_REFRESH_TOKEN=<your-refresh-token>' >> .dev.vars")
    print("  echo 'ADMIN_SECRET=<random-string>' >> .dev.vars")
    print("  pnpm secrets:push")
    print()


if __name__ == "__main__":
    main()
