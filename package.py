#!/usr/bin/env python3
"""Package the generic Apps owner without app examples, data or dependencies."""
from pathlib import Path
import argparse
import hashlib
import json
import zipfile
HERE=Path(__file__).resolve().parent

def sha(file):return hashlib.sha256(file.read_bytes()).hexdigest()
def write_zip(output,files):
    output.parent.mkdir(parents=True,exist_ok=True)
    with zipfile.ZipFile(output,'w',zipfile.ZIP_DEFLATED,compresslevel=9) as z:
        for file,name in sorted(files,key=lambda pair:pair[1]):
            if file.is_symlink():raise ValueError('Links cannot be packaged: '+name)
            info=zipfile.ZipInfo(name,(2026,11,2,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16;z.writestr(info,file.read_bytes())
    with zipfile.ZipFile(output) as z:assert z.testzip() is None
    return {'file':output.name,'bytes':output.stat().st_size,'sha256':sha(output),'entries':len(files)}
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--output',type=Path,default=HERE/'dist');args=parser.parse_args()
    files=[(p,p.name) for p in HERE.iterdir() if p.is_file() and ((p.suffix=='.mjs' and p.name!='check.mjs') or p.name in {'package.json','README.md','WEB-APP-GUIDE.md','LICENSE'})]
    for directory in ['sdk','templates']:
        files += [(p,p.relative_to(HERE).as_posix()) for p in (HERE/directory).rglob('*') if p.is_file()]
    version=json.loads((HERE/'package.json').read_text())['version']
    output=args.output/('aether-apps-'+version+'.zip');result=[write_zip(output,files)]
    assert result[0]['bytes']<1048576,'Generic Apps unexpectedly exceeds 1 MiB; examples must stay separate.'
    args.output.mkdir(parents=True,exist_ok=True);(args.output/'ARTIFACTS.json').write_text(json.dumps({'status':'packaged; consult test and device verification separately','artifacts':result},indent=2)+'\n');print(json.dumps(result,indent=2))
if __name__=='__main__':main()
