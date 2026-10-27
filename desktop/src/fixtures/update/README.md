Real stdout of `EvoSci update --version 0.3.8 --skip webui --json` from core
0.3.7 on Linux (2026-10-27; `rollback` is `--version 0.3.7` from 0.3.8), with
the throwaway home folder shortened to `/home/user`:

- `server_running`: a server without an ownership record answered `/ok` on
  `langgraph_dev_port`;
- `cancel`: a python from the core's environment ran; the cancel file was
  created 2 s after the waiting line;
- `wait_release`: the same, but the process exited 3 s after the waiting
  line, and the update went on (first setup of a new data folder);
- `rollback`, `success`: nothing in the way.
