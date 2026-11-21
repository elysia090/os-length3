"""Validate only fixed GitHub metadata/zip and known reviewed approval inputs."""
import argparse
import hashlib
import json
from pathlib import Path
from zipfile import ZipFile

PROJECT = 1326507637
RUN = 44813799369
ART = 14668298333
ZIP_BYTES = 8232897
ZIP_HASH = "5697afb37d8d36210f337d3cb0b9ddec13940d5564b654b640048ea9fa5135df"
ASSET = 753176307
ROOT_BYTES = 115302848
ROOT_HASH = "ec84d6a4f34359f322726e323e294b03987a19b1aa544563c846ca1a83060ee3"
ROOT_FILENAME = "os-length3-linux-0.6.5-x86_64-" + ROOT_HASH + ".tar.zst"
HEAD = "28c45a65649b1058da0ad5077624e8fd4fa3cee9"
MERGE = "fa19e6277428265ac945d6ce598c709db9b3c787"
WASM_HASH = "1422a0f7e11788880a4c13a78eba901e36813abb8243d5389ea24ac73a1c0614"
PR = "published-busybox-current-config-v1"

def require(value, label):
    if not value:
        raise ValueError(label)

def metadata(release, artifact):
    require(release["tag_name"] == "os-length3-linux-v0.6.5" and release["draft"] is False
            and release["prerelease"] is False, "RELEASE_IDENTITY")
    [a] = [x for x in release["assets"] if x["id"] == ASSET]
    require(a["name"] == ROOT_FILENAME and a["size"] == ROOT_BYTES and a["digest"] == "sha256:" + ROOT_HASH
            and a["browser_download_url"] ==
            "https://github.com/elysia090/os-length3/releases/download/os-length3-linux-v0.6.5/" + ROOT_FILENAME,
            "RELEASE_ASSET_IDENTITY")
    run = artifact["workflow_run"]
    require(artifact["id"] == ART and artifact["name"] == "sods-translator-current-source" and
            artifact["size_in_bytes"] == ZIP_BYTES and artifact["digest"] == "sha256:" + ZIP_HASH and
            artifact["expired"] is False and run["id"] == RUN and run["repository_id"] == PROJECT and
            run["head_repository_id"] == PROJECT and run["head_sha"] == HEAD, "TRANSLATOR_ARTIFACT_IDENTITY")

def extract(archive, out):
    buf = archive.read_bytes()
    require(len(buf)==ZIP_BYTES and hashlib.sha256(buf).hexdigest()==ZIP_HASH, "TRANSLATOR_ZIP_DIGEST")
    with ZipFile(archive) as z:
        require(sorted(z.namelist())==["SHA256SUMS", "sods.wasm", "source-revision.txt"], "TRANSLATOR_ZIP_LAYOUT")
        wasm=z.read("sods.wasm")
        require(z.read("source-revision.txt").decode("ascii").strip()==MERGE, "TRANSLATOR_MERGE_CHECKOUT")
        require(len(wasm)==8232406 and hashlib.sha256(wasm).hexdigest()==WASM_HASH, "TRANSLATOR_WASM_DIGEST")
        stored=z.read("SHA256SUMS").decode("ascii").splitlines()
        require(len(stored)==1 and stored[0]==WASM_HASH + "  sods.wasm", "TRANSLATOR_INNER_RECEIPT")
        with out.open("xb") as f:
            f.write(wasm)

def approval(expected, verified):
    require(expected==verified and set(expected)=={"archive","webroot","translator","muk","busybox"},
            "DERIVATIVE_OUTPUT_DRIFT")
    # This standalone helper does not grant approval. Owner-controlled manual
    # dispatch must have separately accepted the fixed prior-evidence manifest.
    return {"schema":"ricebox-static-root-approval-v1","revision":HEAD,"sha256":expected,
            "provenance":{
            "root":PR + "; authenticated official 0.6.5 carrier plus exact current system-config and assembler; no fresh stock compilation.",
            "busybox":"Official publisher 0.6.5 release asset 753176307; canonical BusyBox ELF carried, not recompiled.",
            "translator":"Same-repo Actions artifact 14668298333; merge checkout fa19e6277428265ac945d6ce598c709db9b3c787, exact Sods source tree; whole Wasm AOT, not native backend.",
            "muk":"Exact product head source-built freestanding Muk, bytes matched independently verified prior pin."
            }}

if __name__=="__main__":
    p=argparse.ArgumentParser()
    p.add_argument("mode",choices=["metadata","extract","approval"])
    p.add_argument("first",type=Path)
    p.add_argument("second",type=Path)
    a=p.parse_args()
    if a.mode=="extract":
        extract(a.first,a.second)
    else:
        values=[json.loads(f.read_bytes()) for f in [a.first,a.second]]
        if a.mode=="metadata":
            metadata(*values)
        else:
            print(json.dumps(approval(*values),sort_keys=True))
