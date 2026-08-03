import os
import sys

from mini_agent import MiniAgentClient


def main() -> None:
    base_url = os.environ.get("MINI_AGENT_URL", "http://127.0.0.1:8787")
    api_key = os.environ.get("MINI_AGENT_API_KEY")
    client = MiniAgentClient(base_url=base_url, api_key=api_key)

    session = client.create_session(
        system_prompt="You are a concise assistant. Prefer tools for arithmetic.",
    )
    print("session:", session.id)

    message = " ".join(sys.argv[1:]) or "What is (12 + 30) * 2?"
    print("user:", message)

    for event in client.run(session_id=session.id, message=message):
        print(f"[{event.payload_case}]", event.payload)


if __name__ == "__main__":
    main()
