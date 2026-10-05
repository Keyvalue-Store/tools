# SPDX-License-Identifier: Apache-2.0
# Copyright 2026 KeyValueStore.com
#
# Writes what Django's own Redis cache backend stores for a model instance:
# RedisSerializer pickles every value except plain integers, with the
# highest pickle protocol. Model instances travel through model_unpickle.
#
#   pip install django
#   python3 inspect/test/generate/django_cache.py

import datetime, json, os, pickle
import django
from django.conf import settings

settings.configure(INSTALLED_APPS=['django.contrib.contenttypes', 'django.contrib.auth'],
                   DATABASES={'default': {'ENGINE': 'django.db.backends.sqlite3', 'NAME': ':memory:'}}, USE_TZ=True)
django.setup()
from django.contrib.auth.models import User
from django.core.cache.backends.redis import RedisSerializer

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'fixtures')
user = User(id=7, username='alice', email='alice@example.com', first_name='Alice', is_staff=True,
            date_joined=datetime.datetime(2026, 10, 5, 9, 0, 0, tzinfo=datetime.timezone.utc))
data = RedisSerializer().dumps(user)

def cj(x):
    if x is None or isinstance(x, (bool, str)): return x
    if isinstance(x, int): return {'i': str(x)}
    if isinstance(x, datetime.datetime): return {'ms': int(x.timestamp() * 1000)}
    if isinstance(x, dict): return {'map': [[cj(k), cj(v)] for k, v in x.items()]}
    if hasattr(x, '__dict__'): return {'obj': type(x).__module__ + '.' + type(x).__qualname__, 'fields': [[k, cj(v)] for k, v in x.__dict__.items()]}
    raise TypeError(type(x))

back = pickle.loads(data)
state = {k: v for k, v in back.__dict__.items()}
expected = {'obj': 'auth.User', 'fields': [[k, cj(v)] for k, v in state.items()]}
with open(os.path.join(OUT, 'django-cache-user.bin'), 'wb') as f: f.write(data)
with open(os.path.join(OUT, 'django-cache-user.json'), 'w') as f:
    json.dump({'source': 'Django %s, django.core.cache.backends.redis.RedisSerializer' % django.get_version(), 'layers': [], 'format': 'pickle', 'value': expected}, f, indent=1)
print('django-cache-user', len(data))
