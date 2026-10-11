import threading
import traceback
import uuid

_jobs = {}
_lock = threading.Lock()


def start_job(kind, target, *args, pass_job_id=False, **kwargs):
    job_id = uuid.uuid4().hex[:10]
    with _lock:
        _jobs[job_id] = {"id": job_id, "kind": kind, "status": "running", "progress": "", "percent": 0, "error": None, "result": None}

    def runner():
        try:
            if pass_job_id:
                result = target(*args, job_id=job_id, **kwargs)
            else:
                result = target(*args, **kwargs)
            with _lock:
                _jobs[job_id]["status"] = "done"
                _jobs[job_id]["result"] = result
                _jobs[job_id]["percent"] = 100
        except Exception as e:
            with _lock:
                _jobs[job_id]["status"] = "error"
                _jobs[job_id]["error"] = f"{e}"
            traceback.print_exc()

    t = threading.Thread(target=runner, daemon=True)
    t.start()
    return job_id


def get_job(job_id):
    with _lock:
        return dict(_jobs[job_id]) if job_id in _jobs else None


def set_progress(job_id, text=None, percent=None):
    with _lock:
        if job_id not in _jobs:
            return
        if text is not None:
            _jobs[job_id]["progress"] = text
        if percent is not None:
            _jobs[job_id]["percent"] = max(0, min(100, round(percent)))
