// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 KeyValueStore.com
//
// k8scodec reads and writes Kubernetes objects the way kube-apiserver keeps
// them in etcd, with Kubernetes' own Go packages. The Revision Viewer uses it
// three ways:
//
//	k8scodec encode   JSON objects in, one a line; the bytes kube-apiserver
//	                  writes to etcd for each out, base64, one a line.
//	k8scodec decode   Those bytes in, base64; for each, the JSON that
//	                  Kubernetes' Go packages make of them and the YAML that
//	                  kubectl prints, as one JSON line. Custom resources,
//	                  which kube-apiserver keeps as JSON, are read the way it
//	                  reads them, into unstructured objects.
//	k8scodec schema   Every stored kind's fields: protobuf number, JSON name,
//	                  type and when JSON leaves the field out. make-schema.js
//	                  turns this into kubernetes.js.
//
// Build it with Go 1.26 or later: cd k8scodec && go mod tidy && go build.
package main

import (
	"bufio"
	"bytes"
	"encoding"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"reflect"
	"sort"
	"strconv"
	"strings"

	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime"
	"k8s.io/apimachinery/pkg/runtime/schema"
	kjson "k8s.io/apimachinery/pkg/runtime/serializer/json"
	"k8s.io/apimachinery/pkg/runtime/serializer/protobuf"
	"sigs.k8s.io/yaml"

	admissionv1 "k8s.io/api/admission/v1"
	admissionv1beta1 "k8s.io/api/admission/v1beta1"
	admissionregistrationv1 "k8s.io/api/admissionregistration/v1"
	admissionregistrationv1alpha1 "k8s.io/api/admissionregistration/v1alpha1"
	admissionregistrationv1beta1 "k8s.io/api/admissionregistration/v1beta1"
	apidiscoveryv2 "k8s.io/api/apidiscovery/v2"
	apidiscoveryv2beta1 "k8s.io/api/apidiscovery/v2beta1"
	apiserverinternalv1alpha1 "k8s.io/api/apiserverinternal/v1alpha1"
	appsv1 "k8s.io/api/apps/v1"
	appsv1beta1 "k8s.io/api/apps/v1beta1"
	appsv1beta2 "k8s.io/api/apps/v1beta2"
	authenticationv1 "k8s.io/api/authentication/v1"
	authenticationv1alpha1 "k8s.io/api/authentication/v1alpha1"
	authenticationv1beta1 "k8s.io/api/authentication/v1beta1"
	authorizationv1 "k8s.io/api/authorization/v1"
	authorizationv1beta1 "k8s.io/api/authorization/v1beta1"
	autoscalingv1 "k8s.io/api/autoscaling/v1"
	autoscalingv2 "k8s.io/api/autoscaling/v2"
	batchv1 "k8s.io/api/batch/v1"
	batchv1beta1 "k8s.io/api/batch/v1beta1"
	certificatesv1 "k8s.io/api/certificates/v1"
	certificatesv1alpha1 "k8s.io/api/certificates/v1alpha1"
	certificatesv1beta1 "k8s.io/api/certificates/v1beta1"
	coordinationv1 "k8s.io/api/coordination/v1"
	coordinationv1alpha2 "k8s.io/api/coordination/v1alpha2"
	coordinationv1beta1 "k8s.io/api/coordination/v1beta1"
	corev1 "k8s.io/api/core/v1"
	discoveryv1 "k8s.io/api/discovery/v1"
	discoveryv1beta1 "k8s.io/api/discovery/v1beta1"
	eventsv1 "k8s.io/api/events/v1"
	eventsv1beta1 "k8s.io/api/events/v1beta1"
	extensionsv1beta1 "k8s.io/api/extensions/v1beta1"
	flowcontrolv1 "k8s.io/api/flowcontrol/v1"
	flowcontrolv1beta1 "k8s.io/api/flowcontrol/v1beta1"
	flowcontrolv1beta2 "k8s.io/api/flowcontrol/v1beta2"
	flowcontrolv1beta3 "k8s.io/api/flowcontrol/v1beta3"
	imagepolicyv1alpha1 "k8s.io/api/imagepolicy/v1alpha1"
	lifecyclev1alpha1 "k8s.io/api/lifecycle/v1alpha1"
	networkingv1 "k8s.io/api/networking/v1"
	networkingv1beta1 "k8s.io/api/networking/v1beta1"
	nodev1 "k8s.io/api/node/v1"
	nodev1alpha1 "k8s.io/api/node/v1alpha1"
	nodev1beta1 "k8s.io/api/node/v1beta1"
	policyv1 "k8s.io/api/policy/v1"
	policyv1beta1 "k8s.io/api/policy/v1beta1"
	rbacv1 "k8s.io/api/rbac/v1"
	rbacv1alpha1 "k8s.io/api/rbac/v1alpha1"
	rbacv1beta1 "k8s.io/api/rbac/v1beta1"
	resourcev1 "k8s.io/api/resource/v1"
	resourcev1alpha3 "k8s.io/api/resource/v1alpha3"
	resourcev1beta1 "k8s.io/api/resource/v1beta1"
	resourcev1beta2 "k8s.io/api/resource/v1beta2"
	schedulingv1 "k8s.io/api/scheduling/v1"
	schedulingv1alpha3 "k8s.io/api/scheduling/v1alpha3"
	schedulingv1beta1 "k8s.io/api/scheduling/v1beta1"
	storagev1 "k8s.io/api/storage/v1"
	storagev1alpha1 "k8s.io/api/storage/v1alpha1"
	storagev1beta1 "k8s.io/api/storage/v1beta1"
	storagemigrationv1 "k8s.io/api/storagemigration/v1"
	storagemigrationv1beta1 "k8s.io/api/storagemigration/v1beta1"

	apiextensionsv1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1"
	apiextensionsv1beta1 "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/v1beta1"
	apiregistrationv1 "k8s.io/kube-aggregator/pkg/apis/apiregistration/v1"
	apiregistrationv1beta1 "k8s.io/kube-aggregator/pkg/apis/apiregistration/v1beta1"
)

var adders = []func(*runtime.Scheme) error{
	admissionv1.AddToScheme, admissionv1beta1.AddToScheme,
	admissionregistrationv1.AddToScheme, admissionregistrationv1alpha1.AddToScheme, admissionregistrationv1beta1.AddToScheme,
	apidiscoveryv2.AddToScheme, apidiscoveryv2beta1.AddToScheme,
	apiserverinternalv1alpha1.AddToScheme,
	appsv1.AddToScheme, appsv1beta1.AddToScheme, appsv1beta2.AddToScheme,
	authenticationv1.AddToScheme, authenticationv1alpha1.AddToScheme, authenticationv1beta1.AddToScheme,
	authorizationv1.AddToScheme, authorizationv1beta1.AddToScheme,
	autoscalingv1.AddToScheme, autoscalingv2.AddToScheme,
	batchv1.AddToScheme, batchv1beta1.AddToScheme,
	certificatesv1.AddToScheme, certificatesv1alpha1.AddToScheme, certificatesv1beta1.AddToScheme,
	coordinationv1.AddToScheme, coordinationv1alpha2.AddToScheme, coordinationv1beta1.AddToScheme,
	corev1.AddToScheme,
	discoveryv1.AddToScheme, discoveryv1beta1.AddToScheme,
	eventsv1.AddToScheme, eventsv1beta1.AddToScheme,
	extensionsv1beta1.AddToScheme,
	flowcontrolv1.AddToScheme, flowcontrolv1beta1.AddToScheme, flowcontrolv1beta2.AddToScheme, flowcontrolv1beta3.AddToScheme,
	imagepolicyv1alpha1.AddToScheme,
	lifecyclev1alpha1.AddToScheme,
	networkingv1.AddToScheme, networkingv1beta1.AddToScheme,
	nodev1.AddToScheme, nodev1alpha1.AddToScheme, nodev1beta1.AddToScheme,
	policyv1.AddToScheme, policyv1beta1.AddToScheme,
	rbacv1.AddToScheme, rbacv1alpha1.AddToScheme, rbacv1beta1.AddToScheme,
	resourcev1.AddToScheme, resourcev1alpha3.AddToScheme, resourcev1beta1.AddToScheme, resourcev1beta2.AddToScheme,
	schedulingv1.AddToScheme, schedulingv1alpha3.AddToScheme, schedulingv1beta1.AddToScheme,
	storagev1.AddToScheme, storagev1alpha1.AddToScheme, storagev1beta1.AddToScheme,
	storagemigrationv1.AddToScheme, storagemigrationv1beta1.AddToScheme,
	// CustomResourceDefinitions and APIServices live outside k8s.io/api.
	apiextensionsv1.AddToScheme, apiextensionsv1beta1.AddToScheme,
	apiregistrationv1.AddToScheme, apiregistrationv1beta1.AddToScheme,
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: k8scodec encode|decode|schema")
		os.Exit(2)
	}
	scheme := runtime.NewScheme()
	for _, add := range adders {
		if err := add(scheme); err != nil {
			panic(err)
		}
	}
	pb := protobuf.NewSerializer(scheme, scheme)
	js := kjson.NewSerializerWithOptions(kjson.DefaultMetaFactory, scheme, scheme, kjson.SerializerOptions{})
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 64<<20), 64<<20)
	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()

	switch os.Args[1] {
	case "encode":
		for in.Scan() {
			obj, _, err := js.Decode(in.Bytes(), nil, nil)
			if err != nil {
				fmt.Fprintln(os.Stderr, "decode JSON:", err)
				os.Exit(1)
			}
			var b strings.Builder
			if err := pb.Encode(obj, &b); err != nil {
				fmt.Fprintln(os.Stderr, "encode protobuf:", err)
				os.Exit(1)
			}
			fmt.Fprintln(out, base64.StdEncoding.EncodeToString([]byte(b.String())))
			out.Flush()
		}
	case "decode":
		for in.Scan() {
			raw, err := base64.StdEncoding.DecodeString(strings.TrimSpace(in.Text()))
			if err != nil {
				panic(err)
			}
			res := map[string]any{}
			var obj runtime.Object
			if bytes.HasPrefix(raw, []byte("k8s\x00")) {
				var gvk *schema.GroupVersionKind
				obj, gvk, err = pb.Decode(raw, nil, nil)
				if err == nil {
					obj.GetObjectKind().SetGroupVersionKind(*gvk)
				}
			} else {
				u := &unstructured.Unstructured{}
				err = u.UnmarshalJSON(raw)
				obj = u
			}
			if err != nil {
				res["error"] = err.Error()
			} else {
				var b strings.Builder
				if err := js.Encode(obj, &b); err != nil {
					res["error"] = err.Error()
				} else {
					res["json"] = json.RawMessage(strings.TrimSpace(b.String()))
					y, err := yaml.Marshal(obj)
					if err != nil {
						res["error"] = err.Error()
					} else {
						res["yaml"] = string(y)
					}
				}
			}
			line, _ := json.Marshal(res)
			out.Write(line)
			out.WriteString("\n")
			out.Flush()
		}
	case "schema":
		writeSchema(scheme, out)
	default:
		fmt.Fprintln(os.Stderr, "usage: k8scodec encode|decode|schema")
		os.Exit(2)
	}
}

// ---- schema ----

type field struct {
	Num       int    `json:"num"`
	Name      string `json:"name"`
	Wire      string `json:"wire"`
	OmitEmpty bool   `json:"omitempty,omitempty"`
	OmitZero  bool   `json:"omitzero,omitempty"`
	Inline    bool   `json:"inline,omitempty"`
	Type      string `json:"type"`
}

// Types whose JSON form is their own, written by a MarshalJSON method, and
// whose protobuf form is a small message of its own.
var special = map[string]string{
	"k8s.io/apimachinery/pkg/apis/meta/v1.Time":       "Time",
	"k8s.io/apimachinery/pkg/apis/meta/v1.MicroTime":  "MicroTime",
	"k8s.io/apimachinery/pkg/apis/meta/v1.Duration":   "Duration",
	"k8s.io/apimachinery/pkg/apis/meta/v1.FieldsV1":   "FieldsV1",
	"k8s.io/apimachinery/pkg/api/resource.Quantity":   "Quantity",
	"k8s.io/apimachinery/pkg/util/intstr.IntOrString": "IntOrString",
	"k8s.io/apimachinery/pkg/runtime.RawExtension":    "RawExtension",
}

var jsonMarshaler = reflect.TypeOf((*json.Marshaler)(nil)).Elem()
var textMarshaler = reflect.TypeOf((*encoding.TextMarshaler)(nil)).Elem()
var protoMarshaler = reflect.TypeOf((*interface{ Marshal() ([]byte, error) })(nil)).Elem()

func fullName(t reflect.Type) string { return t.PkgPath() + "." + t.Name() }

func writeSchema(scheme *runtime.Scheme, out *bufio.Writer) {
	types := map[string][]field{}
	kinds := map[string]string{}
	var walk func(t reflect.Type) string
	walk = func(t reflect.Type) string {
		switch t.Kind() {
		case reflect.Pointer:
			return "*" + walk(t.Elem())
		case reflect.Slice:
			if t.Elem().Kind() == reflect.Uint8 {
				return "bytes"
			}
			// A named list such as ExtraValue travels as a message whose
			// field 1 repeats the items.
			if t.Name() != "" && reflect.PointerTo(t).Implements(protoMarshaler) {
				return "wrap:[]" + walk(t.Elem())
			}
			return "[]" + walk(t.Elem())
		case reflect.Map:
			if t.Key().Kind() != reflect.String {
				panic("a map whose keys aren't strings: " + t.String())
			}
			return "map:" + walk(t.Elem())
		case reflect.Struct:
			name := fullName(t)
			if s, ok := special[name]; ok {
				return s
			}
			// The parts of a CustomResourceDefinition's schema that are
			// either a schema or something else in JSON.
			if strings.HasPrefix(name, "k8s.io/apiextensions-apiserver/pkg/apis/apiextensions/") {
				switch t.Name() {
				case "JSON":
					return "RawJSON"
				case "JSONSchemaPropsOrArray", "JSONSchemaPropsOrBool", "JSONSchemaPropsOrStringArray":
					f, _ := t.FieldByName("Schema")
					return strings.TrimPrefix(t.Name(), "JSONSchemaProps") + ":" + walk(f.Type.Elem())
				}
			}
			if t.Implements(jsonMarshaler) || reflect.PointerTo(t).Implements(jsonMarshaler) || reflect.PointerTo(t).Implements(textMarshaler) {
				panic("a type with its own JSON form that this program doesn't know: " + name)
			}
			if _, done := types[name]; done {
				return name
			}
			types[name] = nil
			var fs []field
			for i := 0; i < t.NumField(); i++ {
				f := t.Field(i)
				ptag := f.Tag.Get("protobuf")
				if ptag == "" || ptag == "-" {
					continue
				}
				parts := strings.Split(ptag, ",")
				num, err := strconv.Atoi(parts[1])
				if err != nil {
					panic(name + "." + f.Name + ": " + ptag)
				}
				jtag := f.Tag.Get("json")
				if jtag == "-" {
					continue
				}
				jparts := strings.Split(jtag, ",")
				fd := field{Num: num, Name: jparts[0], Wire: parts[0], Type: walk(f.Type)}
				for _, o := range jparts[1:] {
					switch o {
					case "omitempty":
						fd.OmitEmpty = true
					case "omitzero":
						fd.OmitZero = true
					case "inline":
						fd.Inline = true
					}
				}
				if fd.Name == "" {
					if !f.Anonymous {
						fd.Name = f.Name
					} else {
						fd.Inline = true
					}
				}
				fs = append(fs, fd)
			}
			sort.Slice(fs, func(a, b int) bool { return fs[a].Num < fs[b].Num })
			types[name] = fs
			return name
		case reflect.String:
			if t.Implements(jsonMarshaler) || t.Implements(textMarshaler) {
				panic("a string type with its own JSON form: " + fullName(t))
			}
			return "string"
		case reflect.Bool:
			return "bool"
		case reflect.Int32, reflect.Int64, reflect.Int:
			return "int"
		case reflect.Uint32, reflect.Uint64, reflect.Uint16, reflect.Uint8:
			return "uint"
		case reflect.Float64, reflect.Float32:
			return "float"
		}
		panic("a type this program doesn't handle: " + t.String())
	}
	objectMeta := "k8s.io/apimachinery/pkg/apis/meta/v1.ObjectMeta"
	var gvks []schema.GroupVersionKind
	for gvk := range scheme.AllKnownTypes() {
		gvks = append(gvks, gvk)
	}
	sort.Slice(gvks, func(a, b int) bool { return gvks[a].String() < gvks[b].String() })
	for _, gvk := range gvks {
		t := scheme.AllKnownTypes()[gvk]
		if t.Kind() != reflect.Struct || strings.HasSuffix(gvk.Kind, "List") {
			continue
		}
		// Only kinds with metadata are kept in etcd.
		m, ok := t.FieldByName("ObjectMeta")
		if !ok || fullName(m.Type) != objectMeta {
			continue
		}
		kinds[gvk.GroupVersion().String()+" "+gvk.Kind] = walk(t)
	}
	b, _ := json.MarshalIndent(map[string]any{"kinds": kinds, "types": types}, "", " ")
	out.Write(b)
	out.WriteString("\n")
}
