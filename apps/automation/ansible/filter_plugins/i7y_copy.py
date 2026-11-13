from __future__ import absolute_import

import re


def safe_failure(data, name):
    text = '\n'.join(str(data.get(key, '')) for key in ('stderr', 'stdout', 'msg'))
    rc = data.get('rc')
    if not isinstance(rc, int):
        rc = None
    reason = 'The command failed.'
    for token, message in (
        ('Incorrect table definition', 'MySQL rejected the temporary table identifier.'),
        ('Multiple primary key', 'A copied table already has a primary key.'),
        ('Unable to prepare a copied table', 'Unable to prepare a copied table for URL replacement.'),
        ('Access denied', 'The copied database rejected its credentials.'),
        ('Error establishing a database connection', 'WordPress cannot connect to the copied database.'),
        ('Permission denied', 'The operation cannot access a required destination file.'),
        ('PHP Fatal error', 'PHP failed while loading the copied WordPress site.'),
        ('Failed opening required', 'A required WordPress file is missing in the copy.'),
        ('Could not connect', 'The copied service is not reachable.'),
        ('No primary key', 'A copied table could not be addressed for URL replacement.'),
        ('command not found', 'A required operation command is unavailable.'),
    ):
        if token in text:
            reason = message
            break
    command = re.search(r'I7Y_WP_COMMAND=(config|core|eval-file|option|search-replace)', text)
    return {'i7y_safe_failure': True, 'name': name, 'rc': rc, 'error': reason,
            'command': 'wordpress.' + command.group(1) if command else 'ansible.task'}


class FilterModule(object):
    def filters(self):
        return {'i7y_safe_failure': safe_failure, 'i7y_preserve_compose': preserve_compose}


def preserve_compose(source, desired, source_domain, destination_domain):
    import json
    import yaml
    desired = json.loads(json.dumps(desired))
    pattern = r'(?<![a-z0-9-])' + re.escape(source_domain) + r'(?![a-z0-9.-])'
    text = re.sub(pattern, lambda match: destination_domain, source, flags=re.IGNORECASE)
    original = yaml.safe_load(text)
    tree = yaml.compose(text)
    edits = []

    def line_start(index):
        return text.rfind('\n', 0, index) + 1

    def render(value, indent):
        return ''.join(' ' * indent + line + '\n' for line in yaml.safe_dump(value, default_flow_style=False, allow_unicode=True).rstrip().splitlines())

    def visit(node, old, new):
        if old == new:
            return
        if isinstance(node, yaml.MappingNode) and isinstance(new, dict) and not node.flow_style:
            entries = {key.value: (key, value) for key, value in node.value}
            for key, (key_node, value_node) in entries.items():
                if key not in new:
                    edits.append((line_start(key_node.start_mark.index), line_start(value_node.end_mark.index), ''))
                else:
                    visit(value_node, old[key], new[key])
            added = {key: value for key, value in new.items() if key not in entries}
            if added:
                index = line_start(node.end_mark.index)
                if node.end_mark.index == len(text):
                    index = len(text)
                prefix = '\n' if index and text[index - 1] != '\n' else ''
                edits.append((index, index, prefix + render(added, node.start_mark.column)))
        elif isinstance(node, yaml.SequenceNode) and isinstance(new, list) and not node.flow_style and len(new) >= len(old):
            for index, child in enumerate(node.value):
                visit(child, old[index], new[index])
            if len(new) > len(old):
                index = line_start(node.end_mark.index)
                if node.end_mark.index == len(text):
                    index = len(text)
                prefix = '\n' if index and text[index - 1] != '\n' else ''
                edits.append((index, index, prefix + render(new[len(old):], node.start_mark.column)))
        else:
            suffix = re.search(r'\n[ \t]*$', text[node.start_mark.index:node.end_mark.index])
            edits.append((node.start_mark.index, node.end_mark.index, json.dumps(new, ensure_ascii=False) + (suffix.group(0) if suffix else '')))

    visit(tree, original, desired)
    for _, (start, end, value) in sorted(enumerate(edits), key=lambda item: (item[1][0], item[1][1], item[0]), reverse=True):
        text = text[:start] + value + text[end:]
    if yaml.safe_load(text) != desired:
        raise ValueError('The destination Compose could not be preserved safely.')
    return text
