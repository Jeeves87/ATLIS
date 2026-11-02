// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (c) 2026 Kalev. Part of the ATLIS Forge bridge; see forge-bridge/LICENSE.

import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.Arrays;

/** Dev tool: print the abstract methods a class leaves for a subclass to implement. */
public class ListAbstract {
    public static void main(String[] args) throws Exception {
        for (String name : args) {
            Class<?> c = Class.forName(name, false, ListAbstract.class.getClassLoader());
            System.out.println("== " + name);
            Arrays.stream(c.getMethods())
                .filter(m -> Modifier.isAbstract(m.getModifiers()))
                .map(ListAbstract::sig)
                .sorted()
                .forEach(s -> System.out.println("  " + s));
        }
    }

    static String sig(Method m) {
        StringBuilder b = new StringBuilder(m.getGenericReturnType().getTypeName()).append(' ').append(m.getName()).append('(');
        b.append(String.join(", ", Arrays.stream(m.getGenericParameterTypes()).map(t -> t.getTypeName()).toList()));
        return b.append(')').toString();
    }
}
