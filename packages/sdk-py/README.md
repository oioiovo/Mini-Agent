# Mini-Agent Python SDK

Thin Connect-over-HTTP client for the Mini-Agent TypeScript runtime.

```bash
pip install -e packages/sdk-py
```

```python
from mini_agent import MiniAgentClient

client = MiniAgentClient(base_url="http://127.0.0.1:8787", api_key="dev-key")
session = client.create_session(system_prompt="Be concise.")
for event in client.run(session_id=session.id, message="What is 2+2?"):
    print(event.payload_case, event.payload)
```
