from backend.namespace import LOCAL, prefix_id, prefix_msg, split_id


def test_split_remote():
    assert split_id("office:3") == ("office", "3")


def test_split_local():
    assert split_id("5") == (LOCAL, "5")


def test_split_empty():
    assert split_id("") == (LOCAL, "")


def test_split_first_colon_only():
    # A remote local-id must survive even if it somehow contains a colon.
    assert split_id("a:b:c") == ("a", "b:c")


def test_prefix_local_stays_bare():
    assert prefix_id(LOCAL, "7") == "7"


def test_roundtrip():
    host, local = split_id(prefix_id("office", "3"))
    assert (host, local) == ("office", "3")


def test_prefix_msg_tags_and_prefixes():
    msg = {"type": "status", "id": "3", "status": "running"}
    out = prefix_msg("office", "Office PC", msg)
    assert out["id"] == "office:3"
    assert out["host"] == "office"
    assert out["hostLabel"] == "Office PC"
    # original must not be mutated (the agent may reuse it)
    assert msg["id"] == "3" and "host" not in msg


def test_prefix_msg_titles_keys():
    out = prefix_msg("office", "o", {"type": "titles", "titles": {"1": "a", "2": "b"}})
    assert out["titles"] == {"office:1": "a", "office:2": "b"}


def test_prefix_msg_non_string_id_untouched():
    out = prefix_msg("office", "o", {"type": "x", "id": 5})
    assert out["id"] == 5
