"""Text-only client for the existing approved local Codex Relay adapter."""
import json
import re
import time
import urllib.error
import urllib.request
from pathlib import Path

_URL = 'http://127.0.0.1:8787/owner-chat/api/messages'
_ORIGIN = 'http://127.0.0.1:8787'
_ID = re.compile(r'[a-zA-Z0-9_:-]{1,100}')
_COMPLETIONS = Path('/Users/pchordia/Documents/foundation/plan/agent-bus/relay-mac-trial-20261009/CODEX_TOOL_RECEIPTS.jsonl.completion.jsonl')


class TextGenerationError(RuntimeError):
    def __init__(self, code):
        self.code = code
        super().__init__('Codex Relay text generation: ' + code)


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        raise TextGenerationError('UNEXPECTED_REDIRECT')


def generate_text(prompt, *, conversation_id, request_id, max_answer_chars=32000, require_completion=False, completion_mode='mcp'):
    """Return saved {conversationId, replyId, answer}; never execute answer text.

    Use a distinct conversation_id per task. Recover a late response by retrying
    the same request_id and identical prompt; a changed prompt needs a new id.
    """
    started = time.monotonic()
    if (not isinstance(prompt, str) or not 1 <= len(prompt.strip()) <= 8000
            or not isinstance(conversation_id, str) or not _ID.fullmatch(conversation_id)
            or not isinstance(request_id, str) or not _ID.fullmatch(request_id)
            or type(max_answer_chars) is not int or not 1 <= max_answer_chars <= 32000
            or type(require_completion) is not bool or completion_mode not in {'mcp', 'swarm-final-text'}
            or (completion_mode == 'swarm-final-text' and
                (not conversation_id.startswith('swarm-task:') or not request_id.startswith('swarm-turn:')))):
        raise TextGenerationError('INVALID_INPUT')
    payload = {'toolId': 'codex', 'prompt': prompt.strip(),
               'externalConversationId': conversation_id, 'requestId': request_id}
    request = urllib.request.Request(_URL, data=json.dumps(payload).encode(),
                                     headers={'Content-Type': 'application/json', 'Origin': _ORIGIN}, method='POST')
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), _NoRedirect())
    try:
        with opener.open(request, timeout=195) as response:
            raw = response.read(2_000_001)
        if len(raw) > 2_000_000:
            raise TextGenerationError('INVALID_RESPONSE')
        result = json.loads(raw)
    except urllib.error.HTTPError as error:
        allowed = {'TOOL_BUSY', 'TOOL_OFFLINE', 'REPLY_PENDING', 'REPLY_NOT_VERIFIED',
                   'REQUEST_CONFLICT', 'INVALID_INPUT', 'RELAY_UNAVAILABLE'}
        try:
            code = json.loads(error.read(4096)).get('error', {}).get('code')
        except Exception:
            code = None
        finally:
            error.close()
        raise TextGenerationError(code if code in allowed else 'CONNECTION_FAILED') from None
    except TextGenerationError:
        raise
    except Exception:
        raise TextGenerationError('CONNECTION_FAILED') from None
    data = result.get('data') if isinstance(result, dict) and result.get('ok') is True else None
    if (not isinstance(data, dict) or not isinstance(data.get('answer'), str)
            or not data['answer'].strip() or len(data['answer']) > 32000
            or not isinstance(data.get('conversationId'), str) or not data['conversationId'].isdigit()
            or not isinstance(data.get('replyId'), str) or not data['replyId'].isdigit()):
        raise TextGenerationError('INVALID_RESPONSE')
    if len(data['answer']) > max_answer_chars:
        # This is a caller acceptance cap, not a model generation/token cap.
        raise TextGenerationError('ANSWER_TOO_LARGE')
    saved = {key: data[key] for key in ('conversationId', 'replyId', 'answer')}
    if require_completion:
        saved['completion'] = _wait_completion(saved, started + 195, completion_mode)
    return saved


def _wait_completion(saved, deadline, mode='mcp'):
    # This fixed file contains only scalar completion projections written by the
    # same local consumer. Never resubmit a prompt or read its private config.
    while True:
        try:
            with _COMPLETIONS.open() as entries:
                for line in entries:
                    try:
                        entry = json.loads(line)
                    except ValueError:
                        continue  # Incomplete concurrent append is retried.
                    if (not isinstance(entry, dict) or entry.get('rootId') != saved['conversationId']
                            or entry.get('replyId') != saved['replyId']):
                        continue
                    if entry.get('scopeTracePassed') is not True:
                        raise TextGenerationError('UNEXPECTED_TOOL_USE')
                    events = entry.get('toolEvents')
                    item_types = entry.get('itemTypes')
                    direct = mode == 'swarm-final-text'
                    if direct and entry.get('mode') != mode:
                        raise TextGenerationError('INVALID_COMPLETION')
                    if (not isinstance(events, list) or (direct and events) or (not direct and not events)
                            or any(not isinstance(event, dict) or event.get('server') != 'relay'
                                   or event.get('name') not in {'get_owner_turn', 'reply_to_thread'}
                                   or event.get('status') not in {'in_progress', 'completed'}
                                   or event.get('failed') is not False for event in events)
                            or not isinstance(item_types, list)
                            or any(item not in ({'agent_message', 'reasoning'} if direct else
                                               {'agent_message', 'reasoning', 'error', 'mcp_tool_call'}) for item in item_types)):
                        raise TextGenerationError('UNEXPECTED_TOOL_USE')
                    if (type(entry.get('exitCode')) is not int or entry['exitCode'] != 0 or
                            (direct and (entry.get('textCompleted') is not True or entry.get('toolsCompleted') is not False
                                         or entry.get('failureCode') is not None)) or
                            (not direct and (entry.get('mode') is not None or entry.get('toolsCompleted') is not True))):
                        raise TextGenerationError('CHILD_FAILED')
                    prompt_id = entry.get('promptMessageId')
                    if (not isinstance(prompt_id, str) or not prompt_id.isdigit()
                            or entry.get('model') != 'gpt-6.1-sol' or not isinstance(entry.get('finishedAt'), str)):
                        raise TextGenerationError('INVALID_COMPLETION')
                    usage = entry.get('usage')
                    usage = {key: value for key, value in usage.items()
                             if key in {'input_tokens', 'cached_input_tokens', 'output_tokens'}
                             and type(value) is int and value >= 0} if isinstance(usage, dict) else None
                    return {'promptMessageId': prompt_id, 'model': entry['model'], 'exitCode': 0,
                            'toolsCompleted': not direct, 'scopeTracePassed': True,
                            'toolEvents': [{key: event.get(key) for key in ('name', 'server', 'status', 'failed')} for event in events],
                            'itemTypes': item_types,
                            'finishedAt': entry['finishedAt'], 'usage': usage or None,
                            **({'mode': mode, 'textCompleted': True, 'failureCode': None} if direct else {})}
        except FileNotFoundError:
            pass
        except OSError:
            raise TextGenerationError('COMPLETION_UNAVAILABLE') from None
        if time.monotonic() >= deadline:
            raise TextGenerationError('COMPLETION_PENDING')
        time.sleep(0.2)
