import os

class Processor:
    def process(self, data: str):
        return data.strip()

def run_processor():
    p = Processor()
    return p.process(" hello ")
