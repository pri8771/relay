import io
import json
import unittest
import urllib.error
import tempfile
from pathlib import Path
from unittest.mock import patch
from text_client import generate_text, TextGenerationError, _NoRedirect, _wait_completion


class ClientTests(unittest.TestCase):
    def test_uses_fixed_local_connection_and_returns_saved_receipt(self):
        receipt = {'conversationId': '123', 'replyId': '124', 'answer': '{"action":"done"}'}
        response = io.BytesIO(json.dumps({'ok': True, 'data': receipt}).encode())
        with patch('urllib.request.build_opener') as make:
            make.return_value.open.return_value = response
            self.assertEqual(generate_text(' prompt ', conversation_id='swarm-task:one', request_id='turn:1'), receipt)
            request = make.return_value.open.call_args.args[0]
            self.assertEqual(request.full_url, 'http://127.0.0.1:8787/owner-chat/api/messages')
            self.assertEqual(request.get_header('Origin'), 'http://127.0.0.1:8787')
            self.assertEqual(json.loads(request.data)['prompt'], 'prompt')
            self.assertEqual(make.return_value.open.call_args.kwargs['timeout'], 195)

    def test_invalid_input_never_connects(self):
        with patch('urllib.request.build_opener') as make:
            for prompt, conversation, request in [('', 'task', 'turn'), ('x'*8001, 'task', 'turn'), ('x','bad/path','turn'), ('x','task','bad path')]:
                with self.assertRaises(TextGenerationError):
                    generate_text(prompt, conversation_id=conversation, request_id=request)
            make.assert_not_called()

    def test_error_is_fixed_and_never_leaks_raw_server_text(self):
        error = urllib.error.HTTPError('unused', 504, 'private error', {}, io.BytesIO(b'{"error":{"code":"REPLY_PENDING","message":"private error"}}'))
        with patch('urllib.request.build_opener') as make:
            make.return_value.open.side_effect = error
            with self.assertRaises(TextGenerationError) as raised:
                generate_text('prompt', conversation_id='task', request_id='turn')
            self.assertEqual(raised.exception.code, 'REPLY_PENDING')
            self.assertNotIn('private', str(raised.exception))

    def test_fabricated_receipt_or_empty_answer_is_rejected(self):
        for data in [{'answer':'text'}, {'conversationId':'123','replyId':'124','answer':''}]:
            with patch('urllib.request.build_opener') as make:
                make.return_value.open.return_value = io.BytesIO(json.dumps({'ok':True,'data':data}).encode())
                with self.assertRaises(TextGenerationError):
                    generate_text('prompt', conversation_id='task', request_id='turn')

    def test_redirect_is_rejected(self):
        with self.assertRaises(TextGenerationError):
            _NoRedirect().redirect_request(None, None, 302, '', {}, 'http://elsewhere/')

    def test_caller_answer_cap_rejects_saved_text_without_truncating_or_retrying(self):
        data = {'conversationId':'123', 'replyId':'124', 'answer':'x'*3073}
        with patch('urllib.request.build_opener') as make:
            make.return_value.open.return_value = io.BytesIO(json.dumps({'ok':True,'data':data}).encode())
            with self.assertRaises(TextGenerationError) as raised:
                generate_text('prompt', conversation_id='task', request_id='turn', max_answer_chars=3072)
            self.assertEqual(raised.exception.code, 'ANSWER_TOO_LARGE')
            self.assertEqual(make.return_value.open.call_count, 1)

    def test_completion_requires_exact_reply_and_actual_successful_child_exit(self):
        saved = {'conversationId':'123', 'replyId':'124', 'answer':'text'}
        entry = {'rootId':'123', 'replyId':'124', 'promptMessageId':'122', 'model':'gpt-6.1-sol',
                 'exitCode':0, 'toolsCompleted':True, 'scopeTracePassed':True, 'finishedAt':'timestamp',
                 'toolEvents':[{'name':'get_owner_turn','server':'relay','status':'completed','failed':False},
                               {'name':'reply_to_thread','server':'relay','status':'completed','failed':False}],
                 'itemTypes':['mcp_tool_call'],
                 'usage': {'output_tokens':12, 'private':'never returned'}}
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder)/'completion.jsonl'
            with patch('text_client._COMPLETIONS',path):
                path.write_text(json.dumps({**entry,'replyId':'999'})+'\npartial append')
                with self.assertRaises(TextGenerationError) as raised:
                    _wait_completion(saved, 0)
                self.assertEqual(raised.exception.code,'COMPLETION_PENDING')
                path.write_text(json.dumps(entry)+'\n')
                result = _wait_completion(saved,0)
                self.assertEqual(result['promptMessageId'],'122')
                self.assertEqual(result['usage'],{'output_tokens':12})
                path.write_text(json.dumps({**entry,'exitCode':1})+'\n')
                with self.assertRaises(TextGenerationError) as raised:
                    _wait_completion(saved,0)
                self.assertEqual(raised.exception.code,'CHILD_FAILED')
                path.write_text(json.dumps({**entry,'scopeTracePassed':False})+'\n')
                with self.assertRaises(TextGenerationError) as raised:
                    _wait_completion(saved,0)
                self.assertEqual(raised.exception.code,'UNEXPECTED_TOOL_USE')
                for status in ('failed','unknown'):
                    path.write_text(json.dumps({**entry,'toolEvents':[
                        {'name':'get_owner_turn','server':'relay','status':status,'failed':False},
                        *entry['toolEvents']]})+'\n')
                    with self.assertRaises(TextGenerationError) as raised:
                        _wait_completion(saved,0)
                    self.assertEqual(raised.exception.code,'UNEXPECTED_TOOL_USE')


if __name__ == '__main__':
    unittest.main()
