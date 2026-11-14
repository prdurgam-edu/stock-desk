"""Builds the look-alike model the service uses.

ResNet-50 v2 from the ONNX model zoo (onnx/models on GitHub), cut at its
global-average-pool layer: instead of naming one of a thousand ImageNet
classes, it gives 2,048 numbers that describe what a picture looks like:
weave, print, embroidery, border, sheen. Two sarees that look alike get
similar numbers. Run by the Dockerfile at build time, so the 98 MB model
never has to live in this repository.
"""
import sys, urllib.request, onnx

URL = ('https://media.githubusercontent.com/media/onnx/models/main/validated/'
       'vision/classification/resnet/model/resnet50-v2-7.onnx')
POOLED = 'resnetv24_flatten0_reshape0'

src, out = sys.argv[1], sys.argv[2]          # src: a local .onnx, or "zoo" to download it
if src == 'zoo':
    urllib.request.urlretrieve(URL, '/tmp/r50.onnx')
    src = '/tmp/r50.onnx'
m = onnx.load(src)
assert any(POOLED in n.output for n in m.graph.node), 'pooled layer not found'
del m.graph.output[:]
m.graph.output.append(onnx.helper.make_tensor_value_info(POOLED, onnx.TensorProto.FLOAT, None))
onnx.save(m, out)
print('wrote', out)
